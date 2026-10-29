'use strict';

// Apoio dos testes dos painéis Obras, Estoque/Patrimônio e Pós-obra (M9-D654): em cima do ambiente dos painéis de BI (painelBiEnv), publica os KPIs de
// Obras, de perdas/pós-obra e de Estoque e grava o snapshot de cada um a partir do caso de teste da própria fórmula, com o filtro de origem dos
// indicadores CRÍTICOS (para o botão "Ver detalhe"). Banco descartável (127.0.0.1). `cleanup` apaga o que a suíte gravou.
const base = require('./painelBiEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const { sourceFilter } = require('../../../src/features/analytics/metrics/kpis/obras/filters');

const { AS_OF, http } = base;
const OBRA_USER = ['analytics:read', 'construction:read'];
const INV_USER = ['analytics:read', 'inventory:read'];
const PREFIX_SQL = '^(obra|inv)[.]';

const dayMs = 86400000;
const iso = (offsetDays) => new Date(new Date(`${AS_OF}T00:00:00-03:00`).getTime() + offsetDays * dayMs).toISOString();

// Filtros de origem dos CRÍTICOS (a data-base é a do painel); os demais indicadores ficam sem origem, como no painel real de detalhe só do que é crítico.
Object.assign(base.FILTERS, {
  'obra.baseline_actual_forecast': () => sourceFilter('obra.baseline_actual_forecast', AS_OF),
  'obra.projected_margin': () => sourceFilter('obra.projected_margin', AS_OF),
  'obra.delays': () => sourceFilter('obra.delays', AS_OF),
  'obra.measurements': () => sourceFilter('obra.measurements', AS_OF),
  'obra.waste': () => ({ equals: { movementType: 'LOSS' } }),
  'obra.postwork_cost': () => ({ equals: { deletedAt: null } }),
  'inv.losses': () => ({ status: ['APPROVED'], period: { from: iso(-29), to: iso(1) } }),
});

async function publishAll(t) {
  await http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const scope = { companyId: t.companyId, groupId: t.groupId };
    await kpis.ensureObraKpisPublished(scope, tx);
    await kpis.obraPerdasKpis.ensurePublished(scope, tx);
    await kpis.estoqueKpis.ensurePublished(scope, tx);
  });
}

async function cleanup(env, t) {
  const c = { c: t.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const ids = `SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code ~ '${PREFIX_SQL}'`;
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN (${ids})`, { replacements: c, transaction });
    await env.admin.query(`UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code ~ '${PREFIX_SQL}'`, { replacements: c, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code ~ '${PREFIX_SQL}'`, { replacements: c, transaction });
  });
  base.dashboards.clearCache();
}

async function setup() {
  const env = await base.setup();
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  return env;
}

async function teardown(env) {
  await cleanup(env, env.tenantA);
  await base.teardown(env);
}

/** Apaga, republica e regrava todos os indicadores dos painéis (volta ao estado de `setup` + `seedPanel`). */
async function reset(env, panels) {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  const out = {};
  for (const panel of panels) Object.assign(out, await base.seedPanel(env.tenantA, panel));
  return out;
}

module.exports = { ...base, OBRA_USER, INV_USER, setup, teardown, cleanup, publishAll, reset };
