'use strict';

/**
 * M9-D630 / M9-D631 — calcula os seis KPIs do funil comercial da empresa a partir dos read models do CRM (nunca do OLTP) com a fórmula versionada do
 * código, e grava o snapshot da data-base com status, hash do cálculo e sourceRefs (M9-D611). Roda na transação do refresh do read model (escritor do
 * BI ligado), depois que o read model foi gravado. Sem escrita fora do schema analytics. Idempotente: só entra revisão se algo mudou.
 */
const store = require('../../metricStore.service');
const { ensureCrmKpisPublished } = require('./crm.register');
const { buildCrmKpiEntries } = require('./crm.entries');
const { writeSnapshotInputs } = require('./finance.snapshots');

/** Devolve { kpis: { código: resultado }, written }. */
async function materializeCrmKpis(scope, asOfDate, transaction) {
  await store.enableAnalyticsWriter(transaction);
  await ensureCrmKpisPublished(scope, transaction);
  const out = { kpis: {}, written: 0 };
  for (const entry of await buildCrmKpiEntries(scope, asOfDate, transaction)) {
    out.written += await writeSnapshotInputs(entry.inputs, transaction);
    out.kpis[entry.code] = entry.result;
  }
  return out;
}

module.exports = { materializeCrmKpis };
