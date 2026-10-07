'use strict';

const { Budget, BudgetLine, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishBudgetApproved, publishProjectStatusChanged } = require('./constructionEvents.service');
const marginRulesService = require('./marginRules.service');

// DECISÃO DE ENGENHARIA (M6-04, ver migração 20260101000182): "construction"."budgets" é o
// agregado da obra — um por projeto (índice único parcial `budgets_unique_per_project`).
// "construction"."budget_lines" (já existente) passa a poder se vincular a um `budgetId`
// opcional. A aprovação (M6-17/M6-32) congela `baselineAmount`/`ruleVersionId` do AGREGADO;
// depois disso, nenhuma linha vinculada a um orçamento `APPROVED` pode ser editada via UPDATE
// direto (ver budgetLines.service.js:updateBudgetLine) — só via Change Order aprovado
// (changeOrders.service.js:approveChangeOrder).

async function createBudget(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'BUDGET_VALIDATION');
  }
  const project = await Project.findByPk(projectId, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  const existing = await Budget.findOne({ where: { projectId }, transaction });
  if (existing) {
    throw AppError.conflict('Esta obra já possui um orçamento agregado — use Change Order para revisar valores após aprovação.', 'BUDGET_ALREADY_EXISTS');
  }

  const budget = await Budget.create(
    {
      groupId,
      companyId,
      projectId,
      status: 'DRAFT',
      totalAmount: 0,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.budget.create',
      entityType: 'Budget',
      entityId: budget.id,
      afterJson: budget.toJSON(),
      reason: `Orçamento agregado criado para a obra ${projectId}.`,
    },
    transaction
  );

  return budget;
}

async function getBudget(id, transaction) {
  const budget = await Budget.findByPk(id, { transaction });
  if (!budget) throw AppError.notFound('Orçamento não encontrado.', 'BUDGET_NOT_FOUND');
  return budget;
}

async function listBudgets(projectId, transaction) {
  return Budget.findAll({ where: { projectId }, order: [['created_at', 'DESC']], transaction });
}

async function approveBudget(id, actorUserId, transaction) {
  // Lock pessimista (M6-17: "approveBudget(): lockForUpdate -> validar DRAFT/permissão ->
  // freezeBaseline -> outbox project.budget.approved") — sem isto, duas aprovações
  // concorrentes do mesmo orçamento poderiam ambas passar pela checagem de status DRAFT antes
  // de qualquer uma commitar, gravando `rule_version_id`/evento duplicados (mesmo padrão de
  // bug já corrigido em projects.service.js:transitionProject).
  const budget = await Budget.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!budget) throw AppError.notFound('Orçamento não encontrado.', 'BUDGET_NOT_FOUND');
  if (budget.status !== 'DRAFT') {
    // Achado numa auditoria do cliente (30/09/2026): "os erros exibidos pro usuário alguns são
    // em código ou inglês" — mensagem traduzida por completo, sem enum cru.
    const statusLabel = budget.status === 'APPROVED' ? 'já aprovado' : 'em rascunho';
    throw AppError.conflict(`Este orçamento está ${statusLabel} — só é possível aprovar um orçamento ainda em rascunho.`, 'BUDGET_NOT_DRAFT');
  }

  // Custo sem dupla digitação (M6-22): o valor congelado vem da SOMA das linhas de orçamento
  // vinculadas a este agregado — nunca de um número digitado solto no corpo da requisição de
  // aprovação.
  const lines = await BudgetLine.findAll({ where: { budgetId: budget.id }, transaction });
  const totalAmount = lines.reduce((sum, line) => sum + Number(line.plannedAmount || 0), 0);

  // Margem via Motor de Regras (M6-23/M6-61): a versão vigente é resolvida e gravada agora —
  // se a regra mudar depois, este orçamento continua apontando para a versão que estava
  // vigente no momento da aprovação.
  const marginRule = await marginRulesService.getActiveMarginRule(budget.groupId, budget.companyId, transaction);

  const beforeJson = budget.toJSON();
  budget.status = 'APPROVED';
  budget.totalAmount = totalAmount;
  budget.baselineAmount = totalAmount;
  budget.ruleVersionId = marginRule.id;
  budget.approvedAt = new Date();
  budget.approvedBy = actorUserId || null;
  budget.updatedBy = actorUserId || null;
  await budget.save({ transaction });

  await publishBudgetApproved(budget, transaction);

  // M6-18: aprovar o orçamento agregado avança a obra PLANNED -> BUDGETED automaticamente —
  // é exatamente esse o marco que a fonte define pra essa transição. Só dispara se a obra
  // ainda estiver PLANNED (idempotente por natureza: Budget só aprova uma vez, DRAFT->APPROVED
  // é caminho único, então isto roda no máximo uma vez por obra).
  //
  // BUG REAL CRÍTICO CORRIGIDO (achado numa auditoria final do Marco 6, 30/09/2026): isto
  // chamava `transitionProject(id, 'BUDGETED', ...)`, a transição GENÉRICA — o que exigia
  // manter 'BUDGETED' em VALID_TRANSITIONS[PLANNED], e isso permitia qualquer chamador bater
  // direto em POST /projects/:id/transition com targetStatus=BUDGETED e pular esta função
  // inteira (sem validar margem mínima, sem congelar baseline nenhuma). Mesmo padrão já usado
  // em DELIVERED/WARRANTY/CLOSED: seta o status DIRETO aqui, fora de VALID_TRANSITIONS — só
  // este gate (approveBudget) pode levar uma obra a BUDGETED.
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 10): faltava lock pessimista aqui — todas as
  // outras transições de Project no módulo (transitionProject/deliverProject/closeProjectWarranty)
  // travam a linha antes de ler-e-escrever, exatamente para evitar lost update. Sem o lock, uma
  // transição concorrente do mesmo Project podia ter sua escrita perdida quando esta transação
  // commitasse depois com um snapshot desatualizado.
  const project = await Project.findByPk(budget.projectId, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (project) {
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 46, 2026-10-05): o contrato
    // (TAB-0700) trata `projects.budget_amount` como o orçamento oficial da obra — mas
    // aprovar o Budget agregado nunca sincronizava esse campo no Project, que ficava para
    // sempre `null` a menos que alguém editasse manualmente via PATCH. Agora o baseline
    // aprovado (sem dupla digitação, já calculado acima a partir da soma das linhas) também
    // vira o budgetAmount oficial da obra.
    project.budgetAmount = budget.baselineAmount;
    if (project.status === 'PLANNED') {
      project.status = 'BUDGETED';
      project.updatedBy = actorUserId || null;
      await project.save({ transaction });
      await publishProjectStatusChanged(project, 'PLANNED', transaction);
    } else {
      project.updatedBy = actorUserId || null;
      await project.save({ transaction });
    }
  }

  await registrarAuditoria(
    {
      groupId: budget.groupId,
      companyId: budget.companyId,
      actorUserId,
      action: 'construction.budget.approve',
      entityType: 'Budget',
      entityId: budget.id,
      beforeJson,
      afterJson: budget.toJSON(),
      reason: `Orçamento ${budget.id} aprovado — baseline imutável congelada em ${totalAmount}, margem mínima vigente ${marginRule.minMarginPct}% (versão ${marginRule.id}).`,
    },
    transaction
  );

  return budget;
}

module.exports = { createBudget, getBudget, listBudgets, approveBudget };
