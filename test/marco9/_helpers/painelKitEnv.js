'use strict';

// Apoio dos testes dos painéis do BI que gravam os snapshots a partir dos casos de teste das fórmulas (M9-D626 Financeiro, M9-D643 Locação): `makeEnv` recebe o padrão dos códigos de
// indicador do painel e a função que publica os KPIs na empresa de teste. Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável (127.0.0.1). Reaproveita da M9-D634 a
// gravação do snapshot e a abertura do painel.
const base = require('./painelBiEnv');

const { AS_OF, NOW, http, registry, dashboards, openPanel, getMetric, seedMetric, seedPanel } = base;

function makeEnv({ own, publish }) {
  const filter = `metric_code ~ '${own}'`;
  async function publishAll(t) {
    await http.inTx(t, { commit: true, writer: true }, (tx) => publish({ companyId: t.companyId, groupId: t.groupId }, tx));
  }
  /** Apaga as definições, versões e snapshots do painel que a suíte gravou na empresa. */
  async function cleanup(env, t) {
    const c = { c: t.companyId };
    await env.admin.transaction(async (transaction) => {
      await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
      const ids = `SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND ${filter}`;
      await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (${ids})`, { replacements: c, transaction });
      await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN (${ids})`, { replacements: c, transaction });
      await env.admin.query(`UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND ${filter}`, { replacements: c, transaction });
      await env.admin.query(`DELETE FROM analytics.metric_definitions WHERE company_id = :c AND ${filter}`, { replacements: c, transaction });
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
  return { AS_OF, NOW, setup, teardown, cleanup, publishAll, openPanel, getMetric, seedMetric, seedPanel, http, registry, dashboards };
}

module.exports = { makeEnv };
