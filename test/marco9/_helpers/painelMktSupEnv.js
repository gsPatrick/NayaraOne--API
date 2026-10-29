'use strict';

// Apoio dos testes dos painéis Marketing e Atendimento/Satisfação do BI (M9-D673): publica os KPIs reais de Marketing e de Atendimento para a empresa de teste e grava os
// snapshots da data-base com o resultado do caso de teste de cada fórmula (valor e dimensões no formato que o KPI grava), sem refazer o cálculo (que tem testes próprios).
// Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável (127.0.0.1). Reaproveita da M9-D634 a gravação do snapshot e a abertura do painel.
const base = require('./painelBiEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, NOW, http, registry, dashboards, openPanel, getMetric, seedMetric, seedPanel } = base;
const MKT_USER = ['analytics:read', 'marketing:attribution:read'];
const SUP_USER = ['analytics:read', 'crm:feedback:read'];
const OWN = "metric_code ~ '^(mkt|sup)[.]'";

async function publishAll(t) {
  await http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const scope = { companyId: t.companyId, groupId: t.groupId };
    await kpis.ensureMarketingKpisPublished(scope, tx);
    await kpis.ensureSupportKpisPublished(scope, tx);
  });
}

/** Apaga as definições, versões e snapshots de Marketing e Atendimento que a suíte gravou na empresa. */
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

module.exports = { AS_OF, NOW, MKT_USER, SUP_USER, setup, teardown, cleanup, publishAll, openPanel, getMetric, seedMetric, seedPanel, http, registry, dashboards };
