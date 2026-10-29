'use strict';

/**
 * M9-D634 (3.3) — o indicador como o painel o entrega: o MESMO objeto que `GET /analytics/metrics/:code` devolve (leitura por `readMetricAsOf`, com a
 * freshness da M9-D609 e a natureza da M9-D610), mais o texto formatado em pt-BR e o caminho de detalhe (M9-D690). Indicador sem registro ou sem
 * snapshot na data-base não derruba o painel: sai INCOMPLETE, sem valor, "Dado incompleto" (BI-015). Valor nulo, DEGRADED e INCOMPLETE mostram o
 * mesmo aviso no lugar do número; nada de valor enganoso.
 */
const { readMetricAsOf } = require('../metrics/registry.asOf');
const { natureLabel } = require('../metrics/registry.natures');
const { P, has, domainPermissionOf } = require('../security');
const { formatValue } = require('./dashboard.format');

const INCOMPLETE_TEXT = 'Dado incompleto';
const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);
const UNKNOWN_FRESHNESS = Object.freeze({ state: 'UNKNOWN', label: 'Ainda sem atualização', ageMinutes: null, sourceSnapshotAt: null, refreshedAt: null, historical: false });

const leafOf = (ref) => ({
  table: ref.table, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, count: ref.count, description: ref.description, restricted: ref.restricted === true,
});

async function readRaw(ctx, metricCode, asOfDate, transaction) {
  try {
    return await readMetricAsOf(
      { companyId: ctx.companyId, groupId: ctx.groupId, permissions: ctx.permissions },
      { metricCode, scopeType: 'COMPANY', scopeId: ctx.companyId, asOfDate }, transaction
    );
  } catch (err) {
    if (MISSING.has(err.code)) return null;
    throw err;
  }
}

/** Indicador sem leitura possível: INCOMPLETE, sem valor, sem selo de atualidade. */
function missingMetric(metricCode, title, asOfDate) {
  return {
    metricCode, name: title, version: null, unit: null, valueNature: null, valueNatureLabel: null, value: null, formatted: null, status: 'INCOMPLETE', incomplete: true,
    incompleteText: INCOMPLETE_TEXT, freshness: { ...UNKNOWN_FRESHNESS, asOfDate }, asOfDate, sourceRefs: [],
  };
}

/** { metric, drilldown }: `meta` = definição publicada (nome, domínio, criticidade); `domainMap` = mapa domínio -> permissão (M9-D700). */
async function readMetricView(ctx, widget, { asOfDate, meta, domainMap }, transaction) {
  const raw = await readRaw(ctx, widget.metric_code, asOfDate, transaction);
  if (!raw) return { metric: missingMetric(widget.metric_code, widget.title, asOfDate), drilldown: { enabled: false, allowed: false, sourceRef: null } };
  const incomplete = raw.value === null || raw.value === undefined || raw.status === 'DEGRADED' || raw.status === 'INCOMPLETE';
  const metric = {
    metricCode: raw.metricCode, name: (meta && meta.name) || widget.title, version: raw.version, unit: raw.unit, valueNature: raw.valueNature, valueNatureLabel: natureLabel(raw.valueNature),
    value: incomplete ? null : raw.value, formatted: incomplete ? null : formatValue(raw.unit, raw.value), status: raw.status, incomplete, incompleteText: incomplete ? INCOMPLETE_TEXT : null,
    freshness: raw.freshness, asOfDate: raw.asOfDate, sourceSnapshotAt: raw.sourceSnapshotAt, refreshedAt: raw.refreshedAt, historical: raw.historical, sourceRefs: raw.sourceRefs,
  };
  const capable = Boolean(meta && (meta.criticality === 'CRITICAL' || meta.drilldownEnabled)) && Array.isArray(raw.sourceRefs) && raw.sourceRefs.length > 0;
  const domainPermission = meta ? domainPermissionOf(domainMap, meta.domain) : null;
  const allowed = capable && has(ctx, P.DRILLDOWN) && has(ctx, domainPermission);
  return { metric, drilldown: { enabled: capable && widget.drilldown_enabled === true, allowed: allowed && widget.drilldown_enabled === true, sourceRef: capable ? leafOf(raw.sourceRefs[0]) : null } };
}

module.exports = { readMetricView, INCOMPLETE_TEXT };
