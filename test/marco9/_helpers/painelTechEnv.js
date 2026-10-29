'use strict';

// Apoio dos testes do painel Segurança/Integrações/IA do BI (M9-D682): publica os KPIs reais de Tecnologia e de IA para a empresa de teste e grava os snapshots da data-base com o
// resultado do caso de teste de cada fórmula (valor e dimensões no formato que o KPI grava), sem refazer o cálculo (que tem testes próprios nas M9-D680 e M9-D681). Relógio fixo em
// 28/10/2026 12:00 de São Paulo. Banco descartável (127.0.0.1). Reaproveita da M9-D634 a gravação do snapshot e a abertura do painel.
const base = require('./painelBiEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const { techFilterOf } = require('../../../src/features/analytics/metrics/kpis/tecnologia/filters');

const { AS_OF, NOW, http, registry, dashboards, openPanel, getMetric, seedMetric, seedPanel } = base;
const TECH_USER = ['analytics:read', 'analytics:read:tech'];
const OWN = "metric_code ~ '^(tec|ai)[.]'";
const NO_BOARD = { windowMinutes: 60 };

// o detalhe do KPI CRITICAL (tec.integration_errors) precisa do filtro assinado da origem
base.FILTERS['tec.integration_errors'] = () => techFilterOf('tec.integration_errors', AS_OF, NO_BOARD);

async function publishAll(t) {
  await http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const scope = { companyId: t.companyId, groupId: t.groupId };
    await kpis.ensureTechKpisPublished(scope, tx);
    await kpis.ensureIaKpisPublished(scope, tx);
  });
}

/** Apaga as definições, versões e snapshots de Tecnologia e IA que a suíte gravou na empresa. */
async function cleanup(env, t) {
  const c = { c: t.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const ids = `SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND ${OWN}`;
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query(`UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND ${OWN}`, { replacements: c, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_definitions WHERE company_id = :c AND ${OWN}`, { replacements: c, transaction });
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

/** Substitui o snapshot da data-base de um indicador (o registro é imutável: apaga o que o teste gravou antes e grava o novo). */
async function reseedMetric(env, t, code, opts) {
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code = :code)', { replacements: { c: t.companyId, code }, transaction });
  });
  dashboards.clearCache();
  return seedMetric(t, code, opts);
}

/** Linha de saúde de uma integração, com os 9 valores (os que o teste não informa ficam como na conexão sem dado). */
const healthRow = (provider, family, environment, extra = {}) => ({
  provider, family, environment, calls: 100, errors: 0, errorLimitPct: '1', successRate: '100.00', latencyP95Ms: 200, latencyP99Ms: 400, rateLimitCount: 0, authFailures: 0, retries: 0, dlq: 0, backlog: 0, quotaRemaining: 1000, ...extra,
});

/** Resultado de tec.integration_errors calculado pela fórmula real sobre as linhas dadas. */
const integrationsResult = (rows) => registry.getFormulaCatalog().get('tec.integration_errors').compute({ rows }, {});

module.exports = { AS_OF, NOW, TECH_USER, setup, teardown, cleanup, publishAll, openPanel, getMetric, seedMetric, reseedMetric, seedPanel, healthRow, integrationsResult, http, registry, dashboards };
