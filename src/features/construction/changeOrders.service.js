'use strict';

const { ChangeOrder, Budget, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { assertEvidenceFilesExist } = require('./evidenceFiles');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const marginRulesService = require('./marginRules.service');
const { computeMarginProjection } = require('./projectHealth.service');
const { createBudgetRevision, listBudgetRevisions } = require('./budgetRevisions.service');

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

// DECISÃO DE ENGENHARIA (M6-06/M6-33): a fonte define 4 estados (DRAFT/PENDING_APPROVAL/
// APPROVED/REJECTED) mas não detalha um endpoint de "submeter" separado do de "criar". Como
// só existe UM endpoint de criação (`POST /construction/projects/:id/change-orders`), o
// Change Order já nasce em `PENDING_APPROVAL` (pronto para decisão) — `DRAFT` fica reservado
// para uma futura tela de rascunho no front que ainda não existe neste marco; o valor
// permanece no enum de status para não quebrar compatibilidade quando essa tela existir.

function assertEvidenceFileIds(evidenceFileIds) {
  if (evidenceFileIds === undefined || evidenceFileIds === null) return [];
  if (!Array.isArray(evidenceFileIds)) {
    throw AppError.badRequest('"evidenceFileIds" deve ser uma lista de IDs de arquivo.', 'CHANGE_ORDER_VALIDATION');
  }
  return evidenceFileIds;
}

async function createChangeOrder(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, reasonCode, description, budgetImpact, scheduleImpactDays, evidenceFileIds, idempotencyKey } = payload;
  if (!groupId || !companyId || !reasonCode || !description || budgetImpact === undefined || budgetImpact === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "reasonCode", "description" e "budgetImpact" são obrigatórios.',
      'CHANGE_ORDER_VALIDATION'
    );
  }
  // BUG REAL CORRIGIDO (auditoria "ciclos até secar", Ciclo 3, Frente C — idempotência faltante,
  // 09/10/2026): retry de rede/duplo-clique no formulário de Change Order criava 2 registros
  // idênticos em PENDING_APPROVAL; se ambos fossem aprovados, budgetImpact era aplicado 2x em
  // budget.baselineAmount/totalAmount e project.budgetAmount (dano financeiro real). Mesmo
  // padrão já usado em materialRequests/stageMeasurements/dailyReports/lossRecords.
  if (!idempotencyKey) {
    throw AppError.badRequest('"idempotencyKey" é obrigatória para criar um Change Order.', 'CHANGE_ORDER_IDEMPOTENCY_KEY_REQUIRED');
  }
  const existing = await ChangeOrder.findOne({ where: { companyId, idempotencyKey }, transaction });
  if (existing) return existing;
  const numericImpact = Number(budgetImpact);
  // FIX (auditoria Marco 6, ciclo 1 novo): só checava Number.isNaN — "budgetImpact": "Infinity"
  // não é NaN, passava o guard e, ao aprovar o Change Order, corrompia pra sempre
  // budget.baselineAmount/totalAmount e project.budgetAmount com o valor numérico 'Infinity'
  // (categoria 14 do catálogo de bugs: NaN/Infinity passando por guard de sinal).
  if (!Number.isFinite(numericImpact)) {
    throw AppError.badRequest('"budgetImpact" deve ser numérico.', 'CHANGE_ORDER_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — F4): o Caderno (p.163)
  // lista "scheduleImpactDays" e "evidenceFileIds" no OBJETO OBRIGATÓRIO do Change Order, mas
  // o código aceitava ambos ausentes/vazios sem bloquear. Decisão de engenharia: exige que
  // scheduleImpactDays seja informado explicitamente (pode ser 0 — "sem impacto de prazo" é
  // uma resposta válida, "não informado" não é) e que evidenceFileIds tenha pelo menos 1
  // arquivo (todo aditivo precisa de alguma evidência que sustente o motivo/impacto alegado).
  if (scheduleImpactDays === undefined || scheduleImpactDays === null || !Number.isFinite(Number(scheduleImpactDays))) {
    throw AppError.badRequest(
      '"scheduleImpactDays" é obrigatório e precisa ser numérico (use 0 quando não houver impacto de prazo).',
      'CHANGE_ORDER_VALIDATION'
    );
  }
  if (!Array.isArray(evidenceFileIds) || evidenceFileIds.length === 0) {
    throw AppError.badRequest(
      '"evidenceFileIds" é obrigatório e precisa ter pelo menos 1 arquivo de evidência sustentando o aditivo.',
      'CHANGE_ORDER_VALIDATION'
    );
  }

  await assertEvidenceFilesExist(evidenceFileIds, companyId, transaction, 'evidenceFileIds');

  // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 17, Frente A, 09/10/2026): lock pessimista na
  // linha do Project, serializando contra removeProject concorrente (ver comentário detalhado
  // em projects.service.js#removeProject) — sem isso, um Change Order podia ser criado ao
  // mesmo tempo em que a obra era excluída, ficando órfão vivo apontando pra um Project já
  // soft-deletado.
  const project = await Project.findByPk(projectId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 12, Frente A, 09/10/2026): nunca comparava
  // project.companyId/groupId com companyId/groupId do payload — dependia só do RLS, sem
  // guarda na camada de serviço (mesma classe de bug já corrigida em createLossRecord/
  // createMaintenanceCase).
  if (project.companyId !== companyId || project.groupId !== groupId) {
    throw AppError.badRequest('Esta obra não pertence à empresa/grupo informado.', 'CHANGE_ORDER_PROJECT_COMPANY_MISMATCH');
  }

  // BUG REAL CORRIGIDO (verificação cética do Marco 6, 13/10/2026): a checagem de
  // idempotencyKey acima (`ChangeOrder.findOne`) acontece ANTES do lock pessimista no Project —
  // duas requisições concorrentes com a MESMA chave podem passar pelo findOne sem ver a
  // criação uma da outra (nenhuma commitou ainda), e só a trava do Project serializa a partir
  // daí. Reproduzido ao vivo com `Promise.allSettled` disparando 2 chamadas idênticas em
  // paralelo: o índice único `change_orders_company_idempotency_unique` do banco sempre
  // rejeitou a segunda tentativa de INSERT — sem este catch, isso vazaria como um
  // SequelizeUniqueConstraintError cru (500) em vez de um erro de negócio tratado. Não dá para
  // simplesmente reconsultar e devolver o registro vencedor NA MESMA transação (o Postgres
  // aborta toda a transação após a violação, até rollback) — por isso a transação precisa ser
  // refeita pelo chamador, igual ao mesmo padrão de corrida já usado em
  // propertyOffers.service.js/person.service.js: erro de conflito claro, retry do cliente cria
  // uma nova transação onde o findOne de idempotência no topo desta função já encontra o
  // registro vencedor e devolve ele, sem duplicar nada.
  let changeOrder;
  try {
    changeOrder = await ChangeOrder.create(
      {
        groupId,
        companyId,
        projectId,
        reasonCode,
        description,
        budgetImpact: numericImpact,
        scheduleImpactDays: scheduleImpactDays != null ? Number(scheduleImpactDays) : null,
        evidenceFileIds: assertEvidenceFileIds(evidenceFileIds),
        idempotencyKey,
        status: 'PENDING_APPROVAL',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Já existe um Change Order criado com esta mesma chave de idempotência (corrida concorrente detectada) — tente novamente.',
        'CHANGE_ORDER_IDEMPOTENCY_RACE'
      );
    }
    throw err;
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.change_order.create',
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
      afterJson: changeOrder.toJSON(),
      reason: `Change Order "${reasonCode}" criado para a obra ${projectId} (impacto: ${numericImpact}).`,
    },
    transaction
  );

  return changeOrder;
}

async function listChangeOrders(projectId, transaction) {
  return ChangeOrder.findAll({ where: { projectId }, order: [['created_at', 'DESC']], transaction });
}

async function getChangeOrder(id, transaction) {
  const changeOrder = await ChangeOrder.findByPk(id, { transaction });
  if (!changeOrder) throw AppError.notFound('Change Order não encontrado.', 'CHANGE_ORDER_NOT_FOUND');
  return changeOrder;
}

async function decideChangeOrder(id, payload, actorUserId, transaction) {
  const decision = String(payload && payload.decision ? payload.decision : '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw AppError.badRequest('"decision" deve ser "APPROVE" ou "REJECT".', 'CHANGE_ORDER_DECISION_INVALID');
  }

  // Lock pessimista no Change Order — mesmo padrão de concorrência já usado em
  // projects.service.js/budgets.service.js: duas decisões simultâneas sobre o mesmo Change
  // Order não podem ambas passar pela checagem de status PENDING_APPROVAL.
  const changeOrder = await ChangeOrder.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!changeOrder) throw AppError.notFound('Change Order não encontrado.', 'CHANGE_ORDER_NOT_FOUND');
  if (changeOrder.status !== 'PENDING_APPROVAL') {
    // Achado numa auditoria do cliente (30/09/2026): mensagem sem enum cru em inglês.
    const labels = { DRAFT: 'rascunho', APPROVED: 'aprovado', REJECTED: 'rejeitado' };
    const statusLabel = labels[changeOrder.status] || changeOrder.status;
    throw AppError.conflict(
      `Este Change Order já está ${statusLabel} — só é possível decidir um Change Order ainda aguardando decisão.`,
      'CHANGE_ORDER_NOT_PENDING'
    );
  }

  const beforeJson = changeOrder.toJSON();

  if (decision === 'REJECT') {
    changeOrder.status = 'REJECTED';
    changeOrder.decidedBy = actorUserId || null;
    changeOrder.decidedAt = new Date();
    changeOrder.updatedBy = actorUserId || null;
    await changeOrder.save({ transaction });

    await registrarAuditoria(
      {
        groupId: changeOrder.groupId,
        companyId: changeOrder.companyId,
        actorUserId,
        action: 'construction.change_order.reject',
        entityType: 'ChangeOrder',
        entityId: changeOrder.id,
        beforeJson,
        afterJson: changeOrder.toJSON(),
        reason: `Change Order ${changeOrder.id} rejeitado.`,
      },
      transaction
    );

    return changeOrder;
  }

  // APPROVE: única forma de mudar o valor de um orçamento já aprovado (Caderno §2). Guia §3: "Nunca UPDATE no baseline
  // aprovado" — a aprovação NÃO toca em budgets.baseline_amount/total_amount nem em projects.budget_amount (o banco
  // recusa: gatilho budgets_baseline_immutable, migration 20260101006602). O aditivo vira uma REVISÃO nova, append-only
  // (construction.budget_revisions), com o total anterior, o impacto e o total novo. Lock pessimista no orçamento:
  // dois Change Orders aprovados ao mesmo tempo não podem gerar o mesmo número de revisão.
  const budget = await Budget.findOne({
    where: { projectId: changeOrder.projectId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!budget || budget.status !== 'APPROVED') {
    throw AppError.conflict(
      'Só é possível aprovar Change Order de obra com orçamento já aprovado (baseline existente).',
      'CHANGE_ORDER_NO_APPROVED_BUDGET'
    );
  }

  // Mesmo gate de bloqueio configurável de approveBudget (Caderno §5 "Margem abaixo da regra gera alerta/bloqueio
  // configurado"): projeta a margem COMO FICARIA com este aditivo (ele ainda está PENDING_APPROVAL aqui).
  const marginRule = await marginRulesService.getActiveMarginRule(changeOrder.groupId, changeOrder.companyId, transaction);
  if (marginRule.enforcementMode === 'BLOCK') {
    const projection = await computeMarginProjection(changeOrder.projectId, transaction, {
      extraApprovedChanges: changeOrder.budgetImpact,
    });
    if (projection.belowMinMargin) {
      throw AppError.unprocessable(
        `Aprovação bloqueada: a margem projetada (${projection.marginPct}%) ficaria abaixo da margem mínima configurada (${marginRule.minMarginPct}%).`,
        'CHANGE_ORDER_APPROVAL_BLOCKED_BY_MARGIN_RULE'
      );
    }
  }

  const revision = await createBudgetRevision(budget, changeOrder, actorUserId, transaction);

  changeOrder.status = 'APPROVED';
  changeOrder.decidedBy = actorUserId || null;
  changeOrder.decidedAt = new Date();
  changeOrder.updatedBy = actorUserId || null;
  await changeOrder.save({ transaction });

  await registrarAuditoria(
    {
      groupId: changeOrder.groupId,
      companyId: changeOrder.companyId,
      actorUserId,
      action: 'construction.change_order.approve',
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
      beforeJson,
      afterJson: { ...changeOrder.toJSON(), budgetRevision: revision.toJSON() },
      reason: `Change Order ${changeOrder.id} aprovado — revisão ${revision.revisionNumber} do orçamento ${budget.id}: ${revision.previousTotal} → ${revision.newTotal} (baseline aprovada ${budget.baselineAmount} intacta).`,
    },
    transaction
  );

  return changeOrder;
}

module.exports = { createChangeOrder, listChangeOrders, getChangeOrder, decideChangeOrder, listBudgetRevisions, STATUSES };
