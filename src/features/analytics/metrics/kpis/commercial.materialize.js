'use strict';

/**
 * M9-D632 / M9-D633 — calcula os oito KPIs de Comercial e Imóveis da empresa a partir dos read models (nunca do OLTP) com a fórmula versionada do código,
 * e grava o snapshot da data-base com status, hash do cálculo e sourceRefs (M9-D611). Roda na transação do refresh do read model (escritor do BI ligado),
 * depois que o read model foi gravado. Sem escrita fora do schema analytics. Pode ser chamado de novo para a mesma data-base: só entra revisão se algo
 * mudou. `only` limita aos códigos cujo read model acabou de ser atualizado.
 */
const store = require('../../metricStore.service');
const { ensureCommercialKpisPublished } = require('./commercial.register');
const { buildCommercialKpiEntries } = require('./commercial.entries');
const { writeSnapshotInputs } = require('./finance.snapshots');
const { DEFINITIONS } = require('./commercial.definitions');

const codesOfModel = (model) => DEFINITIONS.filter((d) => d.sourceReadModel === model).map((d) => d.metricCode);

/** Devolve { kpis: { código: resultado }, written }. */
async function materializeCommercialKpis(scope, asOfDate, transaction, { only = null } = {}) {
  await store.enableAnalyticsWriter(transaction);
  await ensureCommercialKpisPublished(scope, transaction);
  const out = { kpis: {}, written: 0 };
  for (const entry of await buildCommercialKpiEntries(scope, asOfDate, transaction, only)) {
    out.written += await writeSnapshotInputs(entry.inputs, transaction);
    out.kpis[entry.code] = entry.result;
  }
  return out;
}

module.exports = { materializeCommercialKpis, codesOfModel };
