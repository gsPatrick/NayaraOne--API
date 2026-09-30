'use strict';

const { BudgetLine, Budget } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

function assertNonNegativeAmount(value, fieldName) {
  if (value === undefined || value === null) return;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
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
  if (budgetId) {
    const budget = await Budget.findByPk(budgetId, { transaction });
    if (!budget) throw AppError.notFound('Orçamento não encontrado.', 'BUDGET_NOT_FOUND');
    if (budget.status === 'APPROVED') {
      throw AppError.conflict(
        'Este orçamento já está APPROVED (baseline imutável) — novas linhas de custo só via Change Order aprovado.',
        'BUDGET_LINE_BASELINE_LOCKED'
      );
    }
  }

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
    const budget = await Budget.findByPk(line.budgetId, { transaction });
    if (budget && budget.status === 'APPROVED') {
      throw AppError.conflict(
        'Esta linha pertence a um orçamento já aprovado (baseline imutável) — altere o valor só via Change Order aprovado.',
        'BUDGET_LINE_BASELINE_LOCKED'
      );
    }
  }

  const beforeJson = line.toJSON();
  assertNonNegativeAmount(plannedAmount, 'plannedAmount');
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

module.exports = { createBudgetLine, listBudgetLines, getBudgetLine, updateBudgetLine };
