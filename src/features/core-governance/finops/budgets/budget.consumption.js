'use strict';

const readModel = require('../costReadModel');
const { bounds, isClosed } = require('./budget.period');

/** percent = floor(100 x consumo / orçamento), em BigInt (sem ponto flutuante); consumo negativo (crédito acima do gasto) vale 0. */
function percentOf(consumedCents, budgetCents) {
  const consumed = BigInt(consumedCents);
  if (consumed <= 0n) return 0;
  return Number((100n * consumed) / BigInt(budgetCents));
}

/**
 * Consumo do mês de um orçamento (M9-D861 §3.2): as DUAS séries lado a lado, cada uma com o seu total, e a série-base do percentual. Mês aberto, ou fechado
 * sem fatura: ESTIMATED. Mês fechado com fatura BILLED chegada: BILLED, percentual FINAL (não dispara limiar). Nunca soma estimado com faturado.
 */
async function consumptionOf(tenant, budget, monthKey, now, transaction) {
  const { from, to } = bounds(monthKey);
  const series = await readModel.report(tenant, { from, to, environment: budget.environment, domain: budget.domain }, { includeShared: true }, transaction);
  const closed = isClosed(monthKey, now);
  const useBilled = closed && series.billed.lines.length > 0;
  const base = useBilled ? series.billed : series.estimated;
  return {
    monthKey, closed, final: useBilled, baseSeries: useBilled ? 'BILLED' : 'ESTIMATED',
    estimatedCents: series.estimated.totalCents, billedCents: series.billed.totalCents,
    consumedCents: base.totalCents, percent: percentOf(base.totalCents, budget.amount_cents),
  };
}

module.exports = { consumptionOf, percentOf };
