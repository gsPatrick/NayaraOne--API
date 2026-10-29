'use strict';

/**
 * M9-D604 (3.4 e 3.5) — leitura por data. `readMetricAsOf` resolve a versão vigente em `asOfDate` (calendário de São Paulo) e devolve
 * o snapshot gravado daquela versão e data (a maior revision_no). Lê SOMENTE metric_snapshots: nada é calculado na hora para o
 * passado; sem versão ou sem snapshot, 404 ANALYTICS_SNAPSHOT_NOT_AVAILABLE. `recalculateHistorical` refaz o cálculo de uma data
 * passada com a fórmula da versão da época (prova de reprodução: mesmo valor e mesmo calc_hash).
 */
const AppError = require('../../../utils/AppError');
const store = require('../metricStore.service');
const { assertCanRead } = require('./registry.permission');
const { findDefinition } = require('./registry.read');
const { getFormulaCatalog } = require('./formulaCatalog');
const { recalculate } = require('./reproduction');
const { natureLabel } = require('./registry.natures');
const { presentSnapshot } = require('./freshness.present');
const clock = require('./clock');
const { dimensionUnit } = require('./dimensionUnit');

const notAvailable = () => AppError.notFound('Não há registro desse indicador nessa data.', 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');

async function versionAt(ctx, metricCode, asOfDate, transaction) {
  assertCanRead(ctx);
  const definition = await findDefinition(metricCode, transaction);
  const version = await store.getMetricVersionAt(definition.id, asOfDate, transaction);
  if (!version) throw notAvailable();
  return { definition, version };
}

async function readMetricAsOf(ctx, { metricCode, scopeType, scopeId, asOfDate, dimensionKey = '' }, transaction) {
  const { definition, version } = await versionAt(ctx, metricCode, asOfDate, transaction);
  const revisions = await store.listSnapshotRevisions({ metricId: definition.id, metricVersionId: version.id, scopeType, scopeId, asOfDate, dimensionKey }, transaction);
  const snapshot = revisions[revisions.length - 1];
  if (!snapshot) throw notAvailable();
  const rawValue = snapshot.value_numeric != null ? String(snapshot.value_numeric) : snapshot.value_text;
  const shown = await presentSnapshot({ definition, version, snapshot, rawValue, asOfDate, scope: { companyId: ctx.companyId }, transaction }); // M9-D609: freshness no servidor
  return {
    metricCode: definition.metric_code,
    value: shown.value,
    unit: dimensionUnit(dimensionKey, version.unit),
    status: shown.status,
    version: version.version,
    formulaId: version.formula_id,
    valueNature: version.value_nature,
    valueNatureLabel: natureLabel(version.value_nature),
    asOfDate,
    revisionNo: snapshot.revision_no,
    calcHash: snapshot.calc_hash,
    sourceSnapshotAt: snapshot.source_snapshot_at,
    refreshedAt: snapshot.refreshed_at,
    sourceRefs: snapshot.source_refs,
    historical: asOfDate < clock.businessToday(), // M9-D609 3.4: verdadeiro quando a data-base é anterior a hoje (campo da resposta, não coluna)
    freshness: shown.freshness, // M9-D614 regra 5: toda resposta de métrica traz freshness (classificada pela M9-D609)
  };
}

async function recalculateHistorical(ctx, { metricCode, asOfDate, inputs, params }, transaction, options = {}) {
  const { definition, version } = await versionAt(ctx, metricCode, asOfDate, transaction);
  const formula = (options.catalog || getFormulaCatalog()).get(version.formula_id);
  if (!formula) throw AppError.unprocessable('A fórmula informada não existe.', 'ANALYTICS_FORMULA_NOT_FOUND', { formulaId: version.formula_id });
  const used = params === undefined ? version.formula_params : params;
  return { version: version.version, ...recalculate({ formula, metricCode: definition.metric_code, version: version.version, inputs, params: used, asOfDate }) };
}

module.exports = { readMetricAsOf, recalculateHistorical };
