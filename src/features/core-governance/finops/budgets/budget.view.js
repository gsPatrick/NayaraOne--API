'use strict';

const { THRESHOLDS } = require('./budget.constants');
const repo = require('./budget.repository');
const { consumptionOf } = require('./budget.consumption');
const { bounds, monthKeyOf } = require('./budget.period');

const num = (v) => Number(v);

/** Visão do orçamento no mês: cadastro, as duas séries lado a lado (nunca total misto), a série-base, o percentual e os limiares já disparados. */
async function viewOf(tenant, budget, monthKey, now, transaction) {
  const c = await consumptionOf(tenant, budget, monthKey, now, transaction);
  const { from, to } = bounds(monthKey);
  return {
    id: budget.id, environment: budget.environment, domain: budget.domain, periodo: budget.period, valorCentavos: num(budget.amount_cents), responsavelId: budget.owner_user_id,
    mes: { chave: monthKey, de: from, ate: to, fechado: c.closed },
    consumo: { estimado: { totalCentavos: c.estimatedCents }, faturado: { totalCentavos: c.billedCents }, serieBase: c.baseSeries, consumidoCentavos: c.consumedCents },
    percentual: c.percent, percentualFinal: c.final, limiares: THRESHOLDS, disparados: await repo.firedThresholds(budget.id, from, transaction),
  };
}

async function listViews(tenant, transaction, { now = new Date() } = {}) {
  const monthKey = monthKeyOf(now);
  const out = [];
  for (const budget of await repo.list(tenant, transaction)) out.push(await viewOf(tenant, budget, monthKey, now, transaction));
  return out;
}

module.exports = { viewOf, listViews };
