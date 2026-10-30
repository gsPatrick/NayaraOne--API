'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { toMicro, fromMicro } = require('./budgets.money');

/**
 * Excedente do orçamento (DI-IA-LEVE-3): depois de trocar a reserva pelo custo real, cada linha cujo consumido passou do limite
 * ganha uma entrada AI_BUDGET_OVERRUN na trilha (limite, consumido, custo da chamada e excedente). Devolve [{ budgetId, excess }].
 */
async function recordOverrun(ctx, rows, actual, transaction) {
  const out = [];
  for (const row of rows) {
    const excess = toMicro(row.consumedAmount) - toMicro(row.limitAmount);
    if (excess <= 0n) continue;
    const view = { limit: row.limitAmount, consumed: row.consumedAmount, callCost: actual, excess: fromMicro(excess) };
    await registrarAuditoria({
      groupId: row.groupId, companyId: row.companyId, actorUserId: ctx.userId || null, action: 'AI_BUDGET_OVERRUN', entityType: 'AiBudget', entityId: row.id,
      beforeJson: { limit: row.limitAmount }, afterJson: view, reason: 'Custo real acima do limite do orçamento de IA.',
    }, transaction);
    out.push({ budgetId: row.id, excess: view.excess });
  }
  return out;
}

module.exports = { recordOverrun };
