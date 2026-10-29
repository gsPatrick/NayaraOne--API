'use strict';

/**
 * M9-D650 / M9-D651 — calcula os seis KPIs de Obras da empresa a partir dos read models da M9-D618 (nunca do OLTP), com a fórmula versionada do código,
 * e grava o snapshot da data-base com status, hash do cálculo e sourceRefs (M9-D611). Roda na transação do refresh do read model (escritor do BI
 * ligado), depois que o read model foi gravado. Sem escrita fora do schema analytics. Pode ser chamado de novo para a mesma data-base: só entra
 * revisão se algo mudou (snapshot é imutável, M9-D600).
 */
const store = require('../../../metricStore.service');
const { writeSnapshotInputs } = require('../finance.snapshots');
const { ensureObraKpisPublished } = require('./register');
const { buildObraKpiEntries } = require('./entries');
const { hasObraData } = require('./inputs');

/** Devolve { kpis: { código: resultado }, written }. */
async function materializeObraKpis(scope, asOfDate, transaction) {
  if (!(await hasObraData(scope.companyId, transaction))) return { kpis: {}, written: 0 };
  await store.enableAnalyticsWriter(transaction);
  await ensureObraKpisPublished(scope, transaction);
  const out = { kpis: {}, written: 0 };
  for (const entry of await buildObraKpiEntries(scope, asOfDate, transaction)) {
    out.written += await writeSnapshotInputs(entry.inputs, transaction);
    out.kpis[entry.code] = entry.result;
  }
  return out;
}

module.exports = { materializeObraKpis };
