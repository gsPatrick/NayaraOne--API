'use strict';

/**
 * M9-D695 — ferramentas de leitura de indicador da NAY Diretoria: getMetric, getMetricVariation, getMetricBreakdown, getSourceRefs e
 * getFreshness. Só leem o que o BI já gravou (snapshots do registro de métricas); nada é calculado em texto livre e nenhuma consulta vem
 * do modelo. A variação é a única conta, em aritmética decimal exata do BI (M9-D605), feita aqui no servidor.
 */
const AppError = require('../../../utils/AppError');
const { findDefinition, readMetricAsOf, clock } = require('../metrics');
const money = require('../metrics/formulas/money');
const store = require('../nayReadStore.service');
const metricStore = require('../metricStore.service');
const { resolveNayPeriod } = require('./nayTools.period');
const { readMaxItems } = require('../nayToolsSettings');
const { biContext, assertBiRead, assertDomain, companyOf, secureRows } = require('./nayTools.access');

/** Base de toda leitura: permissão do BI, métrica existente, permissão do domínio e empresa do escopo. */
async function openMetric(scope, input, transaction) {
  const ctx = biContext(scope);
  await assertBiRead(ctx);
  const definition = await findDefinition(input.metricCode, transaction);
  await assertDomain(ctx, definition.domain, transaction);
  const companyId = await companyOf(ctx, input.companyId, transaction);
  return { ctx, definition, companyId };
}

const periodView = (p) => ({ label: p.label, startDate: p.startDate, endDate: p.endDate, asOfDate: p.asOfDate });
const read = (ctx, definition, companyId, asOfDate, transaction) => readMetricAsOf(ctx, { metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: companyId, asOfDate }, transaction);

async function getMetric(scope, input, transaction) {
  const { ctx, definition, companyId } = await openMetric(scope, input, transaction);
  const period = resolveNayPeriod(input.period);
  const r = await read(ctx, definition, companyId, period.asOfDate, transaction);
  const row = {
    metricCode: r.metricCode, period: periodView(period), value: r.value, unit: r.unit, status: r.status, version: r.version,
    valueNature: r.valueNature, valueNatureLabel: r.valueNatureLabel, freshness: r.freshness,
  };
  return (await secureRows(ctx, { tool: 'getMetric', resourceCode: r.metricCode, domain: definition.domain, filters: { period: input.period }, rows: [row] }, transaction))[0];
}

const numeric = (v) => { try { return v === null || v === undefined ? null : money.dec(v); } catch (e) { return null; } };

/** Variação de B em relação a A: diferença e percentual sobre |A| (A zero ou valor não numérico: percentual nulo, nunca divisão por zero). */
function variation(valueA, valueB) {
  const a = numeric(valueA);
  const b = numeric(valueB);
  if (!a || !b) return { delta: null, deltaPercent: null };
  const delta = money.sub(b, a);
  const base = money.cmp(a, 0) < 0 ? money.sub(0, a) : a;
  const ratio = money.div(delta, base);
  return { delta: money.toString(delta), deltaPercent: ratio === null ? null : money.round(money.mul(ratio, 100), 2) };
}

async function getMetricVariation(scope, input, transaction) {
  const { ctx, definition, companyId } = await openMetric(scope, input, transaction);
  const periodA = resolveNayPeriod(input.periodA);
  const periodB = resolveNayPeriod(input.periodB);
  const a = await read(ctx, definition, companyId, periodA.asOfDate, transaction);
  const b = await read(ctx, definition, companyId, periodB.asOfDate, transaction);
  const row = {
    metricCode: a.metricCode, unit: a.unit, periodA: periodView(periodA), periodB: periodView(periodB), valueA: a.value, valueB: b.value,
    ...variation(a.value, b.value), statusA: a.status, statusB: b.status, freshnessA: a.freshness, freshnessB: b.freshness,
  };
  return (await secureRows(ctx, { tool: 'getMetricVariation', resourceCode: a.metricCode, domain: definition.domain, filters: { periodA: input.periodA, periodB: input.periodB }, rows: [row] }, transaction))[0];
}

async function getMetricBreakdown(scope, input, transaction) {
  const { ctx, definition, companyId } = await openMetric(scope, input, transaction);
  const period = resolveNayPeriod(input.period);
  const version = await metricStore.getMetricVersionAt(definition.id, period.asOfDate, transaction);
  const declared = version && Array.isArray(version.dimensions) ? version.dimensions : [];
  if (!declared.some((d) => (typeof d === 'string' ? d : d && d.code) === input.dimension)) {
    throw AppError.unprocessable('Esta dimensão não existe para o indicador.', 'ANALYTICS_DIMENSION_NOT_DECLARED', { metricCode: definition.metric_code, dimension: input.dimension });
  }
  const max = await readMaxItems(ctx, transaction);
  const found = await store.listDimensionSnapshots({ metricId: definition.id, companyId, asOfDate: period.asOfDate, dimension: input.dimension, limit: max + 1 }, transaction);
  const items = found.slice(0, max).map((s) => ({
    dimensionValue: s.dimensionKey.slice(input.dimension.length + 1),
    value: s.value_numeric !== null && s.value_numeric !== undefined ? String(s.value_numeric) : s.value_text, status: s.status,
  }));
  const row = { metricCode: definition.metric_code, dimension: input.dimension, period: periodView(period), items, truncated: found.length > max };
  return (await secureRows(ctx, { tool: 'getMetricBreakdown', resourceCode: definition.metric_code, domain: definition.domain, filters: { period: input.period, dimension: input.dimension }, rows: [row] }, transaction))[0];
}

/** Referências de origem do número: tipo, tabela, hash do filtro, contagem e descrição. Nunca os ids nem o filtro assinado (RESTRICTED). */
async function getSourceRefs(scope, input, transaction) {
  const { ctx, definition, companyId } = await openMetric(scope, input, transaction);
  const period = resolveNayPeriod(input.period);
  const r = await read(ctx, definition, companyId, period.asOfDate, transaction);
  const max = await readMaxItems(ctx, transaction);
  const all = Array.isArray(r.sourceRefs) ? r.sourceRefs : [];
  const refs = all.slice(0, max).map((x) => ({
    type: x.type, table: x.table, filterHash: x.filterHash, count: x.count, description: x.description, reconcileMode: x.reconcileMode || null, restricted: true,
  }));
  const row = { metricCode: r.metricCode, period: periodView(period), sourceRefs: refs, truncated: all.length > max };
  return (await secureRows(ctx, { tool: 'getSourceRefs', resourceCode: r.metricCode, domain: definition.domain, filters: { period: input.period }, rows: [row] }, transaction))[0];
}

async function getFreshness(scope, input, transaction) {
  const { ctx, definition, companyId } = await openMetric(scope, input, transaction);
  const latest = await store.latestSnapshotFreshness({ metricId: definition.id, companyId, upTo: clock.businessToday() }, transaction);
  const refreshed = latest && latest.refreshedAt ? new Date(latest.refreshedAt).getTime() : null;
  const row = {
    metricCode: definition.metric_code, hasData: Boolean(latest), asOfDate: latest ? latest.asOfDate : null, status: latest ? latest.status : null,
    sourceSnapshotAt: latest ? latest.sourceSnapshotAt : null, refreshedAt: latest ? latest.refreshedAt : null,
    ageMinutes: refreshed === null ? null : Math.max(0, Math.floor((clock.now().getTime() - refreshed) / 60000)),
  };
  return (await secureRows(ctx, { tool: 'getFreshness', resourceCode: definition.metric_code, domain: definition.domain, rows: [row] }, transaction))[0];
}

module.exports = { getMetric, getMetricVariation, getMetricBreakdown, getSourceRefs, getFreshness, variation };
