'use strict';

const { checkStalledCases } = require('./correspondentNay.service');

/**
 * Casos de financiamento parados em forma de AGREGADO (M9-D035), pelo limiar `stalledCaseDays` do Correspondente: só a quantidade por etapa,
 * sem caso, cliente nem motivo. A lista nominal com o motivo é dos agentes do correspondente (M9-D039). Somente leitura.
 */
async function getStalledSummary(groupId, companyId, transaction) {
  const r = await checkStalledCases(groupId, companyId, {}, transaction);
  const by = new Map();
  for (const c of r.cases) by.set(c.status, (by.get(c.status) || 0) + 1);
  return {
    source: 'correspondent.financing_cases',
    asOf: new Date().toISOString(),
    mode: 'SUMMARY',
    thresholdDays: r.thresholdDays,
    total: r.cases.length,
    truncated: false,
    byStage: [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([status, count]) => ({ status, count })),
  };
}

module.exports = { getStalledSummary };
