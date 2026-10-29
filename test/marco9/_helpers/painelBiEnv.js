'use strict';

// Apoio dos testes dos painéis de BI (M9-D634, M9-D662): publica os KPIs reais do registro para a empresa de teste e grava os snapshots da data-base a
// partir dos casos de teste das próprias fórmulas (valor e dimensões já no formato que o KPI grava), sem refazer o cálculo de cada KPI (que tem testes
// próprios). Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável (127.0.0.1). `cleanup` apaga o que a suíte gravou.
const http = require('./analyticsHttpEnv');
const registry = require('../../../src/features/analytics/metrics');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const { ensureCommercialKpisPublished } = require('../../../src/features/analytics/metrics/kpis/commercial');
const store = require('../../../src/features/analytics/metricStore.service');
const dashboards = require('../../../src/features/analytics/dashboards');
const { buildSourceRefs } = require('../../../src/features/analytics/metrics/sourceRefs.build');
const { filtersOf } = require('../../../src/features/analytics/metrics/kpis/crm.filters');
const { calcHash } = require('../../../src/features/analytics/metrics/calcHash');
const { legalFilterOf } = require('../../../src/features/analytics/metrics/kpis/legalCor/legal.filters');
const { corFilterOf } = require('../../../src/features/analytics/metrics/kpis/legalCor/cor.filters');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const PREFIX = /^(crm|prop|radar|legal|cor)\./;

const CRM_USER = ['analytics:read', 'crm:opportunities:read'];
const LEGAL_USER = ['analytics:read', 'legal:read'];
const COR_USER = ['analytics:read', 'correspondent:read'];

/** Filtros assinados (origem do número) dos KPIs CRITICAL que o teste abre no detalhe; os demais ficam sem origem. */
const FILTERS = {
  'crm.opportunities_by_stage': () => filtersOf(AS_OF, false).byCode['crm.opportunities_by_stage'],
  'crm.portfolio_without_next_action': () => filtersOf(AS_OF, false).byCode['crm.portfolio_without_next_action'],
  'legal.deadlines': () => legalFilterOf('legal.deadlines', AS_OF, { finishedStatuses: ['CLOSED'] }),
  'legal.cases_by_risk': () => legalFilterOf('legal.cases_by_risk', AS_OF, { finishedStatuses: ['CLOSED'] }),
  'cor.commission': () => corFilterOf('cor.commission', AS_OF),
};

async function publishAll(t) {
  await http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const scope = { companyId: t.companyId, groupId: t.groupId };
    await kpis.ensureCrmKpisPublished(scope, tx);
    await ensureCommercialKpisPublished(scope, tx);
    await kpis.ensureLegalKpisPublished(scope, tx);
    await kpis.ensureCorrespondentKpisPublished(scope, tx);
  });
}

/** Caso de teste da fórmula com status OK e dimensões (o "típico"); serve de resultado do KPI no snapshot. */
function caseOf(code) {
  const formula = registry.getFormulaCatalog().get(code);
  const ok = (formula.testCases || []).filter((c) => c.expected && c.expected.status === 'OK');
  return [...ok].sort((a, b) => (b.expected.dimensions || []).length - (a.expected.dimensions || []).length)[0]; // o caso com mais dimensões
}

async function metricIds(code, tx) {
  const [[row]] = await tx.sequelize.query(
    `SELECT d.id AS "metricId", v.id AS "metricVersionId", v.version, v.unit FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = (SELECT NULLIF(current_setting('app.company_id', true), '')::uuid)`, { replacements: { code }, transaction: tx });
  return row;
}

/**
 * Grava o snapshot de `code`. opts: { degraded } (status DEGRADED, valor nulo, sem dimensões), { stale } (fonte lida há horas), { never } (sem instante
 * de fonte), { result } (resultado no lugar do caso da fórmula: { value, status, dimensions }).
 */
async function seedMetric(t, code, opts = {}) {
  const result = opts.result || (opts.degraded ? { value: null, status: 'DEGRADED', dimensions: [] } : caseOf(code).expected);
  return http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const ids = await metricIds(code, tx);
    const ctx = { groupId: t.groupId, companyId: t.companyId, permissions: ['analytics:read'] };
    const filter = FILTERS[code] && FILTERS[code]();
    const sourceRefs = filter ? (await buildSourceRefs(ctx, code, { filter, unit: ids.unit }, tx)).sourceRefs : [];
    const base = {
      metricId: ids.metricId, metricVersionId: ids.metricVersionId, groupId: t.groupId, companyId: t.companyId, scopeType: 'COMPANY', scopeId: t.companyId,
      periodStart: '2026-10-01', periodEnd: AS_OF, asOfDate: AS_OF, status: result.status,
      sourceSnapshotAt: opts.never ? null : opts.stale ? (typeof opts.stale === 'string' ? opts.stale : '2026-10-26T12:00:00Z') : NOW.toISOString(), sourceRefs, calcHash: calcHash({ code, result }),
    };
    await store.recordSnapshot({ ...base, dimensionKey: '', valueNumeric: result.value }, tx);
    for (const d of result.dimensions || []) await store.recordSnapshot({ ...base, dimensionKey: d.key, valueNumeric: d.value }, tx);
    return { result, version: ids.version };
  });
}

async function seedPanel(t, panel, opts = {}) {
  const out = {};
  for (const w of panel.widgets.filter((x) => x.metricCode)) {
    if ((opts.skip || []).includes(w.metricCode)) continue;
    out[w.metricCode] = await seedMetric(t, w.metricCode, { degraded: (opts.degraded || []).includes(w.metricCode), stale: (opts.stale || []).includes(w.metricCode) });
  }
  return out;
}

async function cleanup(env, t) {
  const c = { c: t.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const ids = "SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND (metric_code ~ '^(crm|prop|radar|legal|cor)[.]')";
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query("UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code ~ '^(crm|prop|radar|legal|cor)[.]'", { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code ~ '^(crm|prop|radar|legal|cor)[.]'", { replacements: c, transaction });
  });
  dashboards.clearCache();
}

async function setup() {
  registry.clock.setClock(() => NOW);
  const env = await http.setup();
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  return env;
}

async function teardown(env) {
  await cleanup(env, env.tenantA);
  registry.clock.resetClock();
  await http.teardown(env);
}

/** GET do painel pela rota real (cache sempre limpo, salvo `keepCache`). */
function openPanel(env, code, { perms, tenant = 'A', query = `asOf=${AS_OF}`, keepCache = false } = {}) {
  if (!keepCache) dashboards.clearCache();
  return env.call('GET', `/analytics/dashboards/${code}?${query}`, { perms, tenant });
}

const getMetric = (env, code, perms) => env.call('GET', `/analytics/metrics/${code}?asOf=${AS_OF}`, { perms });

module.exports = { AS_OF, NOW, PREFIX, FILTERS, CRM_USER, LEGAL_USER, COR_USER, setup, teardown, seedMetric, seedPanel, cleanup, publishAll, openPanel, getMetric, caseOf, dashboards, registry, http };
