'use strict';

const { BudgetLine } = require('../../models');
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
  const { groupId, companyId, category, description, plannedAmount, costCenterId } = payload;
  if (!groupId || !companyId || !category || plannedAmount === undefined || plannedAmount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "category" e "plannedAmount" são obrigatórios.',
      'BUDGET_LINE_VALIDATION'
    );
  }
  // FIX (auditoria adversarial): plannedAmount/actualAmount aceitavam valor negativo tanto na
  // criação quanto na edição — mesmo padrão de bug já achado em RDO/etapa de obra.
  assertNonNegativeAmount(plannedAmount, 'plannedAmount');

  const line = await BudgetLine.create(
    {
      groupId,
      companyId,
      projectId,
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
  const beforeJson = line.toJSON();
  const { category, description, plannedAmount, actualAmount, costCenterId } = payload;
  assertNonNegativeAmount(plannedAmount, 'plannedAmount');
  assertNonNegativeAmount(actualAmount, 'actualAmount');
  if (category !== undefined) line.category = category;
  if (description !== undefined) line.description = description;
  if (plannedAmount !== undefined) line.plannedAmount = plannedAmount;
  if (actualAmount !== undefined) line.actualAmount = actualAmount;
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
