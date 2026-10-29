'use strict';

/**
 * M9-D694 (3.1) — variação entre períodos calculada pelo SERVIDOR, na aritmética decimal exata do BI. O modelo recebe a variação pronta e não
 * calcula. `absolute = current - previous`; `percent = absolute / |previous| x 100` em 2 casas (previous zero: percent nulo). Cada ponta é a
 * leitura do registro de métricas na data-base do período (M9-D604/M9-D609): se as duas pontas foram calculadas por versões diferentes da
 * métrica, a variação sai com `versionChanged = true` e o aviso "a fórmula mudou entre os períodos".
 */
const { readMetricAsOf } = require('../metrics');
const metricStore = require('../metricStore.service');
const { variation } = require('./nayTools.metric');

const VERSION_CHANGED_WARNING = 'A fórmula mudou entre os períodos.';

const periodView = (p) => ({ startDate: p.startDate, endDate: p.endDate, asOfDate: p.asOfDate });

/** Leitura de uma ponta: valor/estado/frescor/fonte do registro, mais o id do snapshot; null se o dia não tem registro. */
async function readSide(ctx, definition, companyId, period, transaction) {
  let read;
  try {
    read = await readMetricAsOf(ctx, { metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: companyId, asOfDate: period.asOfDate }, transaction);
  } catch (err) {
    if (err && err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return null;
    throw err;
  }
  const version = await metricStore.getMetricVersionAt(definition.id, period.asOfDate, transaction);
  const revisions = await metricStore.listSnapshotRevisions({
    metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: companyId, asOfDate: period.asOfDate,
  }, transaction);
  return { read, snapshotId: revisions.length ? revisions[revisions.length - 1].id : null };
}

/**
 * Variação do período corrente contra o anterior para uma métrica. Devolve { definition, current, previous, variation } em que `current` e
 * `previous` são as leituras (ou null) e `variation` é o objeto do livro (ou null quando falta uma ponta ou o valor não é numérico).
 */
async function computeVariation({ ctx, definition, companyId, periodCurrent, periodPrevious }, transaction) {
  const current = await readSide(ctx, definition, companyId, periodCurrent, transaction);
  const previous = await readSide(ctx, definition, companyId, periodPrevious, transaction);
  let result = null;
  if (current && previous && current.read.value !== null && previous.read.value !== null) {
    const v = variation(previous.read.value, current.read.value);
    if (v.delta !== null) {
      const versionChanged = current.read.version !== previous.read.version;
      result = {
        current: String(current.read.value), previous: String(previous.read.value), absolute: v.delta, percent: v.deltaPercent,
        periodCurrent: periodView(periodCurrent), periodPrevious: periodView(periodPrevious),
        snapshotCurrentId: current.snapshotId, snapshotPreviousId: previous.snapshotId,
        versionCurrent: current.read.version, versionPrevious: previous.read.version, versionChanged,
        ...(versionChanged ? { warning: VERSION_CHANGED_WARNING } : {}),
      };
    }
  }
  return { definition, current: current ? current.read : null, previous: previous ? previous.read : null, variation: result };
}

module.exports = { computeVariation, VERSION_CHANGED_WARNING };
