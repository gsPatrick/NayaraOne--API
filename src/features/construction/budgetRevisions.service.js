'use strict';

const { BudgetRevision, ChangeOrder } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Revisões do orçamento aprovado (verificação independente do Marco 6: M6-17, M6-82, M6-42). Guia §3 "Nunca UPDATE no
 * baseline aprovado": cada Change Order aprovado cria UMA revisão nova, append-only (a tabela recusa UPDATE/DELETE no
 * banco), encadeada por número; o total vigente do orçamento = baseline aprovada + soma dos aditivos aprovados = total
 * novo da última revisão.
 */
function toCents(value) {
  return Math.round(Number(value) * 100);
}

async function createBudgetRevision(budget, changeOrder, actorUserId, transaction) {
  const last = await BudgetRevision.findOne({ where: { budgetId: budget.id }, order: [['revision_number', 'DESC']], transaction });
  const previousCents = last ? toCents(last.newTotal) : toCents(budget.baselineAmount);
  const impactCents = toCents(changeOrder.budgetImpact);
  const newCents = previousCents + impactCents;
  if (newCents < 0) {
    throw AppError.badRequest('Aplicar este Change Order deixaria o orçamento com valor negativo.', 'CHANGE_ORDER_NEGATIVE_RESULT');
  }
  return BudgetRevision.create(
    {
      groupId: budget.groupId,
      companyId: budget.companyId,
      budgetId: budget.id,
      projectId: budget.projectId,
      revisionNumber: last ? last.revisionNumber + 1 : 1,
      changeOrderId: changeOrder.id,
      previousTotal: (previousCents / 100).toFixed(2),
      budgetImpact: (impactCents / 100).toFixed(2),
      newTotal: (newCents / 100).toFixed(2),
      reason: `Change Order ${changeOrder.reasonCode}: ${changeOrder.description}`.slice(0, 2000), // scanner:allow — tamanho máximo do texto do motivo, não valor monetário
      createdBy: actorUserId || null,
    },
    { transaction }
  );
}

/** Revisões de uma obra (mais antiga primeiro), com o motivo do Change Order de origem. */
async function listBudgetRevisions(projectId, transaction) {
  const rows = await BudgetRevision.findAll({ where: { projectId }, order: [['revision_number', 'ASC']], transaction });
  const coIds = rows.map((r) => r.changeOrderId).filter(Boolean);
  const cos = coIds.length ? await ChangeOrder.findAll({ where: { id: coIds }, attributes: ['id', 'reasonCode', 'scheduleImpactDays'], transaction }) : [];
  const byId = new Map(cos.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r.toJSON(), changeOrder: byId.get(r.changeOrderId) || null }));
}

module.exports = { createBudgetRevision, listBudgetRevisions };
