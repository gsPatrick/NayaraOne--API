'use strict';

const { ensureCurrentPeriod } = require('./budgets.resolve');

/** Virada de período de uma empresa: abre a linha do mês de `now` para cada escopo que já teve orçamento (consumo em 0, alertas rearmados). */
async function rolloverCompany(ctx, transaction, { now = new Date() } = {}) {
  return { created: await ensureCurrentPeriod(ctx, now, transaction) };
}

module.exports = { rolloverCompany };
