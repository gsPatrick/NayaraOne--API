'use strict';

// Apoio dos testes da M9-D608 (rebuild de read model): fonte simulada, read model de teste com `rebuild.keys`, aplicação de eventos com commit
// e leitura do estado da tabela. Roda SÓ em banco descartável (127.0.0.1). Tudo o que os testes gravam com commit é removido no teardown.
const crypto = require('node:crypto');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const money = require('../../../src/features/analytics/metrics/formulas/money');

async function setup() {
  const base = await sup.setup();
  const sfx = sup.sfx();
  const env = { ...base, sfx, model: `rm_m9d608_${sfx}`, source: `m9d608_src_${sfx}`, eventType: `m9d608.entry.settled.${sfx}`, failAccounts: new Set(), corrections: [] };
  await env.admin.query(`CREATE TABLE analytics.${env.source} (id serial PRIMARY KEY, company_id uuid NOT NULL, account_id text NOT NULL, amount numeric(18,2) NOT NULL, settled boolean NOT NULL)`);
  await env.admin.query(`CREATE TABLE analytics.${env.model} (company_id uuid NOT NULL, group_id uuid NOT NULL, account_id text NOT NULL, balance numeric(18,2) NOT NULL, entries int NOT NULL,
    source_snapshot_at timestamptz, refreshed_at timestamptz NOT NULL, version int NOT NULL, UNIQUE (company_id, account_id))`);
  await env.admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.${env.source}, analytics.${env.model} TO nayara_runtime; GRANT USAGE ON SEQUENCE analytics.${env.source}_id_seq TO nayara_runtime; END IF; END $$`);
  await env.admin.query(`ALTER TABLE analytics.${env.model} ENABLE ROW LEVEL SECURITY; ALTER TABLE analytics.${env.model} FORCE ROW LEVEL SECURITY;
    CREATE POLICY t_all ON analytics.${env.model} USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
  await env.admin.query(`ALTER TABLE analytics.${env.source} ENABLE ROW LEVEL SECURITY; ALTER TABLE analytics.${env.source} FORCE ROW LEVEL SECURITY;
    CREATE POLICY t_all ON analytics.${env.source} USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
  env.def = readModels.registerReadModel(definition(env));
  return env;
}

function definition(env) {
  return {
    name: env.model,
    version: 2,
    keyColumns: ['account_id'],
    eventTypes: [env.eventType],
    aggregateKey: (event) => (event.payloadJson && event.payloadJson.accountId ? { account_id: event.payloadJson.accountId } : null),
    async recompute({ companyId, key, transaction }) {
      if (env.failAccounts.has(key.account_id)) throw Object.assign(new Error('falha simulada ao ler a fonte'), { code: 'M9D608_FONTE' });
      const [rows] = await sequelize.query(`SELECT amount, settled FROM analytics.${env.source} WHERE company_id = :companyId AND account_id = :account`, { replacements: { companyId, account: key.account_id }, transaction });
      return { fields: { balance: money.toString(money.sum(rows.filter((r) => r.settled).map((r) => r.amount))), entries: rows.length } };
    },
    rebuild: {
      async keys({ companyId, transaction }) {
        const [rows] = await sequelize.query(`SELECT DISTINCT account_id FROM analytics.${env.source} WHERE company_id = :companyId ORDER BY 1`, { replacements: { companyId }, transaction });
        return rows.map((r) => ({ account_id: r.account_id }));
      },
      corrections: async () => env.corrections.splice(0),
    },
  };
}

async function addSource(env, tenant, account, amount, settled = true) {
  await env.admin.query(`INSERT INTO analytics.${env.source} (company_id, account_id, amount, settled) VALUES (:c, :a, :m, :s)`, { replacements: { c: tenant.companyId, a: account, m: amount, s: settled } });
}

const makeEvent = (env, tenant, account) => ({
  id: crypto.randomUUID(), eventType: env.eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: account, payloadJson: { accountId: account }, occurredAt: new Date(), retryCount: 0,
});

/** Aplica um evento como o worker faz, com commit (o estado fica gravado no read model). */
async function applyCommitted(env, tenant, account) {
  const event = makeEvent(env, tenant, account);
  await sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(event, tx));
  return event;
}

/** Linhas do read model da empresa, em ordem, sem as colunas de metadado (a comparação campo a campo). */
async function tableRows(env, tenant) {
  const [rows] = await env.admin.query(`SELECT account_id, balance::text AS balance, entries FROM analytics.${env.model} WHERE company_id = :c ORDER BY account_id`, { replacements: { c: tenant.companyId } });
  return rows;
}

const ctxFor = (tenant, { permissions = ['analytics:rebuild'], reason = null } = {}) => ({ groupId: tenant.groupId, actorUserId: tenant.userId, permissions, reason });

async function lastRefresh(env, tenant) {
  const [[row]] = await env.admin.query(`SELECT * FROM analytics.read_model_refreshes WHERE read_model = :m AND company_id = :c AND "trigger" = 'REBUILD' ORDER BY started_at DESC LIMIT 1`, { replacements: { m: env.model, c: tenant.companyId } });
  return row || null;
}

/** Nome da tabela sombra de uma empresa (M9-D608 L-2: uma por empresa e modelo). */
const shadowOf = (env, tenant = env.tenantA) => `${env.model}__rb${tenant.companyId.replace(/-/g, '').slice(0, 8)}`;
const shadowExists = async (env, tenant = env.tenantA) => (await env.admin.query(`SELECT to_regclass('analytics.${shadowOf(env, tenant)}') AS t`))[0][0].t !== null;

async function teardown(env) {
  readModels.unregisterReadModel(env.model);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'data_quality_checks', 'read_model_refreshes']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE read_model = :m`, { replacements: { m: env.model }, transaction });
    }
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type = 'analytics.read_model.rebuilt' AND payload_json->>'readModel' = :m", { replacements: { m: env.model }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.rebuild.%'", { transaction });
  });
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${shadowOf(env, env.tenantA)}, analytics.${shadowOf(env, env.tenantB)}, analytics.${env.model}, analytics.${env.source}, analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

module.exports = { setup, teardown, addSource, makeEvent, applyCommitted, tableRows, ctxFor, lastRefresh, shadowExists, shadowOf, inTx: sup.inTx, sfx: sup.sfx, sequelize };
