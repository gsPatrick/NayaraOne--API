'use strict';

// Apoio dos testes da M9-D696 (qualidade de dados) com um read model de teste SEM índice único (para provocar duplicidade), fonte simulada
// e uma passada de "refresh" que grava o diário e roda os checks. Banco descartável apenas (127.0.0.1).
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const quality = require('../../../src/features/analytics/quality');
const clock = require('../../../src/features/analytics/metrics/clock');
const refreshStore = require('../../../src/features/analytics/readModelRefreshStore.service');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');

const NOW = new Date('2026-10-28T15:00:00Z');
const TENANT_POLICY = "company_id = NULLIF(current_setting('app.company_id', true), '')::uuid";

async function setup() {
  const base = await sup.setup();
  const sfx = sup.sfx();
  const env = { ...base, sfx, model: `rm_m9d696_${sfx}`, source: `m9d696_src_${sfx}` };
  await env.admin.query(`CREATE TABLE analytics.${env.source} (id serial PRIMARY KEY, company_id uuid NOT NULL, account_id text NOT NULL, amount numeric(18,2) NOT NULL)`);
  await env.admin.query(`CREATE TABLE analytics.${env.model} (company_id uuid NOT NULL, group_id uuid NOT NULL, account_id text NOT NULL, balance numeric(18,2) NOT NULL,
    source_snapshot_at timestamptz, refreshed_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 1)`);
  for (const table of [env.source, env.model]) {
    await env.admin.query(`ALTER TABLE analytics.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE analytics.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY t_all ON analytics.${table} USING (${TENANT_POLICY}) WITH CHECK (${TENANT_POLICY})`);
  }
  await env.admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.${env.source}, analytics.${env.model} TO nayara_runtime; GRANT USAGE ON SEQUENCE analytics.${env.source}_id_seq TO nayara_runtime; END IF; END $$`);
  clock.setClock(() => NOW);
  return env;
}

const addSource = (env, tenant, account, amount) => env.admin.query(`INSERT INTO analytics.${env.source} (company_id, account_id, amount) VALUES (:c, :a, :m)`, { replacements: { c: tenant.companyId, a: account, m: amount } });
const addModelRow = (env, tenant, account, balance, snapshotAt = NOW) => env.admin.query(
  `INSERT INTO analytics.${env.model} (company_id, group_id, account_id, balance, source_snapshot_at) VALUES (:c, :g, :a, :b, :s)`,
  { replacements: { c: tenant.companyId, g: tenant.groupId, a: account, b: balance, s: snapshotAt } }
);
const clearModel = (env, tenant) => env.admin.query(`DELETE FROM analytics.${env.model} WHERE company_id = :c`, { replacements: { c: tenant.companyId } });

/** Histórico de refreshes bem-sucedidos (linhas gravadas por lote), do mais antigo para o mais novo. */
async function seedHistory(env, tenant, counts) {
  for (const [i, rows] of counts.entries()) {
    await sup.inTx(tenant, { commit: true }, async (tx) => {
      await enableAnalyticsWriter(tx);
      const r = await refreshStore.startRefresh({ groupId: tenant.groupId, companyId: tenant.companyId, readModel: env.model, trigger: 'EVENT', version: 1 }, tenant, tx);
      await refreshStore.finishRefresh(r.id, { status: 'SUCCEEDED', rowsUpserted: rows }, tenant, tx);
      await sequelize.query('UPDATE analytics.read_model_refreshes SET started_at = :t, finished_at = :t WHERE id = :id', { replacements: { t: new Date(NOW.getTime() - (counts.length - i + 1) * 3600000), id: r.id }, transaction: tx });
    });
  }
}

/** Um refresh (lote) que gravou `rows` linhas, seguido dos checks do read model. Devolve o resultado dos checks e o id do refresh. */
async function refresh(env, tenant, { rows = 1, mode = 'EVENT' } = {}) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    const r = await refreshStore.startRefresh({ groupId: tenant.groupId, companyId: tenant.companyId, readModel: env.model, trigger: mode === 'SCHEDULE' ? 'SCHEDULE' : 'EVENT', version: 1 }, tenant, tx);
    const done = await refreshStore.finishRefresh(r.id, { status: 'SUCCEEDED', rowsUpserted: rows, sourceSnapshotAt: NOW }, tenant, tx);
    const out = await quality.checkRefresh({ readModel: env.model, scope: { companyId: tenant.companyId, groupId: tenant.groupId }, refreshId: done.id, rowsUpserted: rows, mode }, tx);
    return { ...out, refreshId: done.id };
  });
}

/** Remove um refresh e os checks dele (para o teste não entrar na média móvel das chamadas seguintes). */
async function dropRefresh(env, id) {
  await env.admin.query('DELETE FROM analytics.data_quality_checks WHERE refresh_id = :id', { replacements: { id } });
  await env.admin.query('DELETE FROM analytics.read_model_refreshes WHERE id = :id', { replacements: { id } });
}
const clearHistory = (env) => env.admin.query('DELETE FROM analytics.data_quality_checks WHERE read_model = :m; DELETE FROM analytics.read_model_refreshes WHERE read_model = :m', { replacements: { m: env.model } });

const refreshStatus = async (env, id) => (await env.admin.query('SELECT status, error_code FROM analytics.read_model_refreshes WHERE id = :id', { replacements: { id } }))[0][0];
const savedChecks = async (env, tenant) => (await env.admin.query(
  'SELECT * FROM analytics.data_quality_checks WHERE read_model = :m AND company_id = :c ORDER BY executed_at, created_at', { replacements: { m: env.model, c: tenant.companyId } }
))[0];
const statusOf = (out, code) => out.results.find((r) => r.checkCode === code);

async function teardown(env) {
  quality.unregisterChecks(env.model);
  clock.resetClock();
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of ['data_quality_checks', 'read_model_refreshes']) await env.admin.query(`DELETE FROM analytics.${t} WHERE read_model = :m`, { replacements: { m: env.model }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.qualidade.%' OR key LIKE 'analytics.freshness.%'", { transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type = 'analytics.quality.check_failed' AND payload_json->>'readModel' = :m", { replacements: { m: env.model }, transaction });
  });
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.model}, analytics.${env.source}, analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

module.exports = { dropRefresh, clearHistory, setup, teardown, addSource, addModelRow, clearModel, seedHistory, refresh, refreshStatus, savedChecks, statusOf, NOW, inTx: sup.inTx, sequelize, quality };
