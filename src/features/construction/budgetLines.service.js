'use strict';

const { BudgetLine, Budget } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertCostCenterBelongsToCompany } = require('./costCenterValidation');

function assertNonNegativeAmount(value, fieldName) {
  if (value === undefined || value === null) return;
  const numeric = Number(value);
  // FIX (auditoria Marco 6, ciclo 1 novo): só checava Number.isNaN, mas Number('Infinity') não
  // é NaN — "plannedAmount": "Infinity" passava direto e corrompia o total do orçamento
  // (mesma classe de bug catalogada na categoria 14: NaN/Infinity passando por guard de sinal).
  if (!Number.isFinite(numeric)) {
    throw AppError.badRequest(`"${fieldName}" deve ser numérico.`, 'BUDGET_LINE_VALIDATION');
  }
  if (numeric < 0) {
    throw AppError.badRequest(`"${fieldName}" não pode ser negativo.`, 'BUDGET_LINE_VALIDATION');
  }
}

async function createBudgetLine(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, category, description, plannedAmount, costCenterId, budgetId } = payload;
  if (!groupId || !companyId || !category || plannedAmount === undefined || plannedAmount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "category" e "plannedAmount" são obrigatórios.',
      'BUDGET_LINE_VALIDATION'
    );
  }
  // FIX (auditoria adversarial): plannedAmount/actualAmount aceitavam valor negativo tanto na
  // criação quanto na edição — mesmo padrão de bug já achado em RDO/etapa de obra.
  assertNonNegativeAmount(plannedAmount, 'plannedAmount');

  // Baseline imutável (M6-17): não é possível acrescentar linha nova a um orçamento agregado
  // já `APPROVED` — isso aumentaria o custo total sem passar por Change Order.
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 7, 2026-10-06): lia o Budget sem lock
  // pessimista antes de checar o status — corrida real contra approveBudget (que TRAVA a
  // linha do Budget antes de aprovar): se createBudgetLine lesse DRAFT e só inserisse a linha
  // DEPOIS do commit de approveBudget, a linha nova entrava num orçamento que já estava
  // congelado como baseline imutável, sem passar por Change Order. Mesmo padrão de bug já
  // corrigido em outras transições de status do módulo (Categoria 1 do catálogo).
  if (budgetId) {
    const budget = await Budget.findByPk(budgetId, {
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!budget) throw AppError.notFound('Orçamento não encontrado.', 'BUDGET_NOT_FOUND');
    // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 10, Frente B, 09/10/2026): nunca comparava
    // budget.projectId com o projectId do contexto da chamada (parâmetro de rota) — era possível
    // criar uma BudgetLine na Obra A apontando pra um budgetId que pertence à Obra B, sem erro,
    // aparecendo listada dentro da Obra A via listBudgetLines (confusão de orçamento entre obras).
    if (budget.projectId !== projectId) {
      throw AppError.badRequest(
        'Este orçamento pertence a outra obra — não é possível vincular uma linha de custo a um orçamento de obra diferente.',
        'BUDGET_LINE_BUDGET_PROJECT_MISMATCH'
      );
    }
    if (budget.status === 'APPROVED') {
      throw AppError.conflict(
        'Este orçamento já está aprovado (baseline imutável) — novas linhas de custo só via Change Order aprovado.',
        'BUDGET_LINE_BASELINE_LOCKED'
      );
    }
  }
  await assertCostCenterBelongsToCompany(costCenterId, companyId, transaction);

  const line = await BudgetLine.create(
    {
      groupId,
      companyId,
      projectId,
      budgetId: budgetId || null,
      costCenterId: costCenterId || null,
      category,
      description: description || null,
      plannedAmount,
      actualAmount: null,
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
      action: 'construction.budget_line.create',
      entityType: 'BudgetLine',
      entityId: line.id,
      afterJson: line.toJSON(),
      reason: `Linha de orçamento "${category}" criada para a obra ${projectId}.`,
    },
    transaction
  );

  return line;
}

async function listBudgetLines(projectId, transaction) {
  return BudgetLine.findAll({ where: { projectId }, order: [['created_at', 'ASC']], transaction });
}

async function getBudgetLine(id, transaction) {
  const line = await BudgetLine.findByPk(id, { transaction });
  if (!line) throw AppError.notFound('Linha de orçamento não encontrada.', 'BUDGET_LINE_NOT_FOUND');
  return line;
}

async function updateBudgetLine(id, payload, actorUserId, transaction) {
  const line = await getBudgetLine(id, transaction);

  // M6-22 (CORRIGIDO em 30/09/2026 — auditoria pós-merge encontrou o gap): "custo realizado
  // sempre vem de Financeiro/Estoque via evento, nunca digitado solto dentro de Obras".
  // `actualAmount` NUNCA pode ser setado por este endpoint de edição manual — hoje nenhum
  // consumidor de evento popula esse campo ainda (dependência cruzada com a integração real
  // de custo por linha de orçamento, fora do escopo desta correção pontual), mas o gap real e
  // urgente era permitir digitação manual livre; fechado aqui incondicionalmente, e não só
  // quando a linha já tem `budgetId` de um orçamento aprovado — a regra é "nunca via UPDATE
  // direto", não "só depois de aprovado".
  if (payload.actualAmount !== undefined) {
    throw AppError.badRequest(
      '"actualAmount" não pode ser editado diretamente — custo realizado só é populado automaticamente via integração com Financeiro/Estoque.',
      'BUDGET_LINE_ACTUAL_AMOUNT_READONLY'
    );
  }

  // Baseline imutável (M6-17): se a linha está vinculada a um orçamento agregado já
  // `APPROVED`, o campo `plannedAmount` também não pode ser alterado por este caminho de
  // UPDATE direto — a única forma de alterar valor depois da aprovação é um Change Order
  // aprovado (ver changeOrders.service.js:decideChangeOrder). Campos não financeiros
  // (category/description/costCenterId) continuam editáveis livremente.
  const { category, description, plannedAmount, costCenterId } = payload;
  if (plannedAmount !== undefined && line.budgetId) {
    // Mesmo lock pessimista de createBudgetLine (ver comentário acima) — sem isto, a mesma
    // corrida contra approveBudget permitia editar plannedAmount de uma linha depois que o
    // orçamento já tinha virado baseline imutável.
    const budget = await Budget.findByPk(line.budgetId, {
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (budget && budget.status === 'APPROVED') {
      throw AppError.conflict(
        'Esta linha pertence a um orçamento já aprovado (baseline imutável) — altere o valor só via Change Order aprovado.',
        'BUDGET_LINE_BASELINE_LOCKED'
      );
    }
  }

  const beforeJson = line.toJSON();
  assertNonNegativeAmount(plannedAmount, 'plannedAmount');
  if (costCenterId !== undefined) await assertCostCenterBelongsToCompany(costCenterId, line.companyId, transaction);
  if (category !== undefined) line.category = category;
  if (description !== undefined) line.description = description;
  if (plannedAmount !== undefined) line.plannedAmount = plannedAmount;
  if (costCenterId !== undefined) line.costCenterId = costCenterId;
  line.updatedBy = actorUserId || null;
  await line.save({ transaction });

  await registrarAuditoria(
    {
      groupId: line.groupId,
      companyId: line.companyId,
      actorUserId,
      action: 'construction.budget_line.update',
      entityType: 'BudgetLine',
      entityId: line.id,
      beforeJson,
      afterJson: line.toJSON(),
      reason: `Linha de orçamento ${line.id} atualizada.`,
    },
    transaction
  );

  return line;
}

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 8, 2026-10-06): não existia NENHUM
// jeito, via API nem via UI, de remover uma linha de orçamento digitada errada antes da
// aprovação — só editar. Mesmo padrão de baseline imutável das outras funções: bloqueia
// fail-closed quando a linha já pertence a um orçamento APPROVED (só Change Order pode mudar
// valor depois disso).
async function removeBudgetLine(id, actorUserId, transaction) {
  const line = await getBudgetLine(id, transaction);
  if (line.budgetId) {
    const budget = await Budget.findByPk(line.budgetId, {
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (budget && budget.status === 'APPROVED') {
      throw AppError.conflict(
        'Esta linha pertence a um orçamento já aprovado (baseline imutável) — não pode ser excluída.',
        'BUDGET_LINE_BASELINE_LOCKED'
      );
    }
  }

  const beforeJson = line.toJSON();
  line.deletedBy = actorUserId || null;
  await line.save({ transaction });
  await line.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: line.groupId,
      companyId: line.companyId,
      actorUserId,
      action: 'construction.budget_line.remove',
      entityType: 'BudgetLine',
      entityId: line.id,
      beforeJson,
      reason: `Linha de orçamento ${line.id} excluída.`,
    },
    transaction
  );
}

module.exports = { createBudgetLine, listBudgetLines, getBudgetLine, updateBudgetLine, removeBudgetLine };
