'use strict';

const { pctOf } = require('./budgets.money');

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Linha do orçamento -> objeto da API. `params` traz os valores efetivos quando a linha segue os parâmetros da empresa. */
function toBudget(row, params, alerts = []) {
  return {
    id: row.id,
    agentCode: row.agentCode,
    modelClass: row.modelClass,
    period: row.period,
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
    limitAmount: row.limitAmount,
    consumedAmount: row.consumedAmount,
    reservedAmount: row.reservedAmount,
    consumedPct: pctOf(row.consumedAmount, row.limitAmount),
    // Nomes do contrato de GET /ai/budgets (M9-D031): os mesmos valores, sem recálculo.
    limit: row.limitAmount,
    consumed: row.consumedAmount,
    reserved: row.reservedAmount,
    pct: pctOf(row.consumedAmount, row.limitAmount),
    thresholds: row.thresholds || null,
    effectiveThresholds: row.thresholds || params.thresholds,
    actionAt100: row.actionAt100 || null,
    effectiveActionAt100: row.actionAt100 || params.actionAt100,
    status: row.status,
    alerts: alerts.map((a) => ({ threshold: a.threshold, consumedPct: a.consumedPct, consumedAmount: a.consumedAmount, raisedAt: iso(a.createdAt) })),
  };
}

/** Retrato para a auditoria (antes/depois): só valores de controle. */
function auditSnapshot(row) {
  return {
    id: row.id, agentCode: row.agentCode, modelClass: row.modelClass, limitAmount: row.limitAmount, consumedAmount: row.consumedAmount,
    thresholds: row.thresholds || null, actionAt100: row.actionAt100 || null, status: row.status, periodStart: iso(row.periodStart),
  };
}

module.exports = { toBudget, auditSnapshot };
