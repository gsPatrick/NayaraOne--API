'use strict';

/**
 * M9-D685 — leitura das fontes do Centro de Comando: o MESMO registro de métricas dos demais painéis (leitura por data da M9-D604, com freshness e qualidade), mais as
 * linhas de dimensão do snapshot. Nunca toca tabela de origem (BI-012). O ABAC não barra a leitura (o Centro mostra "+N itens que você não pode ver"): quem decide o
 * que aparece é `visibleTo`, com o domínio da métrica e o mapa de permissões da M9-D700.
 */
const store = require('../../dashboardReadStore.service');
const { readMetricAsOfUnchecked } = require('../../metrics/registry.asOf');
const { has, domainPermissionOf } = require('../../security');
const { formatValue } = require('../dashboard.format');
const { dimensionUnit } = require('../../metrics/dimensionUnit');

const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);

/** Fonte de um indicador: { code, ok, value, unit, name, domain, dims (Map chave -> texto decimal), freshness, status }. `ok` = há valor confiável. */
async function readSource(ctx, code, asOfDate, meta, transaction) {
  const readOf = { companyId: ctx.companyId, groupId: ctx.groupId, permissions: ctx.permissions || [] };
  let read;
  try {
    read = await readMetricAsOfUnchecked(readOf, { metricCode: code, scopeType: 'COMPANY', scopeId: ctx.companyId, asOfDate }, transaction);
  } catch (err) {
    if (MISSING.has(err.code)) return { code, ok: false, value: null, unit: null, name: (meta && meta.name) || code, domain: meta ? meta.domain : 'GENERAL', dims: new Map(), status: 'INCOMPLETE', freshness: null };
    throw err;
  }
  const reliable = read.valueReliable !== false && read.value !== null && read.value !== undefined && !['DEGRADED', 'INCOMPLETE'].includes(read.status);
  const rows = reliable ? await store.listDimensionSnapshots({ metricCode: code, version: read.version, companyId: ctx.companyId, asOfDate }, transaction) : [];
  return {
    code, ok: reliable, value: reliable ? String(read.value) : null, unit: read.unit, name: (meta && meta.name) || code, domain: meta ? meta.domain : 'GENERAL',
    dims: new Map(rows.map((r) => [r.key, r.value])), status: read.status, freshness: read.freshness, valueNature: read.valueNature, sourceRefs: read.sourceRefs,
  };
}

/** Lê várias fontes de uma vez: Map(código -> fonte). */
async function readSources(ctx, codes, asOfDate, transaction) {
  const unique = [...new Set(codes)];
  const metas = new Map((await store.listMetricMeta(unique, transaction)).map((m) => [m.metricCode, m]));
  const out = new Map();
  for (const code of unique) out.set(code, await readSource(ctx, code, asOfDate, metas.get(code), transaction));
  return out;
}

const dim = (source, key) => (source.dims.has(key) ? source.dims.get(key) : null);
const isPositive = (text) => text !== null && text !== undefined && /^-?\d+(\.\d+)?$/.test(String(text)) && Number(text) > 0;
const fmt = (source, key, value) => formatValue(key ? dimensionUnit(key, source.unit) : source.unit, value);

/** O usuário pode ver os itens deste domínio? (permissão do módulo de origem, mapa M9-D700; o domínio geral usa analytics:read.) */
const visibleTo = (ctx, map, domain) => has(ctx, domainPermissionOf(map, domain));

module.exports = { readSource, readSources, dim, isPositive, fmt, visibleTo };
