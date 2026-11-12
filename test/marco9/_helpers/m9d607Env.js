'use strict';

// Apoio dos testes da M9-D607 (worker de read models): fonte simulada, read model de teste registrado e fábrica de eventos.
// Roda SÓ em banco descartável (127.0.0.1). Tudo o que os testes gravam com commit é removido no teardown.
const crypto = require('node:crypto');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const EVENT_TYPE_PREFIX = 'm9d607.entry';

async function setup() {
  const base = await sup.setup();
  const sfx = sup.sfx();
  const env = {
    ...base,
    sfx,
    model: `rm_m9d607_${sfx}`,
    source: `m9d607_src_${sfx}`,
    settledType: `${EVENT_TYPE_PREFIX}.settled.${sfx}`,
    reads: [],
    failAccounts: new Set(),
  };
  await env.admin.query(`CREATE TABLE analytics.${env.source} (id serial PRIMARY KEY, company_id uuid NOT NULL, account_id text NOT NULL, amount numeric(18,2) NOT NULL, settled boolean NOT NULL, due_date date NOT NULL)`);
  await env.admin.query(`CREATE TABLE analytics.${env.model} (company_id uuid NOT NULL, group_id uuid NOT NULL, account_id text NOT NULL, balance numeric(18,2) NOT NULL, overdue_count int NOT NULL,
    source_snapshot_at timestamptz, refreshed_at timestamptz NOT NULL, version int NOT NULL, UNIQUE (company_id, account_id))`);
  await env.admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.${env.source}, analytics.${env.model} TO nayara_runtime; GRANT USAGE ON SEQUENCE analytics.${env.source}_id_seq TO nayara_runtime; END IF; END $$`);
  env.def = readModels.registerReadModel(definition(env));
  return env;
}

function definition(env) {
  return {
    name: env.model,
    version: 3,
    keyColumns: ['account_id'],
    eventTypes: [env.settledType],
    aggregateKey: (event) => (event.payloadJson && event.payloadJson.accountId ? { account_id: event.payloadJson.accountId } : null),
    async recompute({ companyId, key, limit, asOfDate, transaction }) {
      if (env.failAccounts.has(key.account_id)) throw Object.assign(new Error('falha simulada ao ler a fonte'), { code: 'M9D607_FONTE' });
      const cap = limit == null ? '' : 'LIMIT :cap';
      const [rows] = await sequelize.query(
        `SELECT amount, settled, to_char(due_date, 'YYYY-MM-DD') AS due FROM analytics.${env.source} WHERE company_id = :companyId AND account_id = :account ${cap}`,
        { replacements: { companyId, account: key.account_id, cap: (limit || 0) + 1 }, transaction });
      env.reads.push({ account: key.account_id, rows: rows.length, limit });
      if (limit != null && rows.length > limit) return { truncated: true };
      const balance = money.toString(money.sum(rows.filter((r) => r.settled).map((r) => r.amount)));
      const overdue = rows.filter((r) => !r.settled && r.due < asOfDate).length;
      return { fields: { balance, overdue_count: overdue } };
    },
    scheduled: {
      async keys({ companyId, transaction }) {
        const [rows] = await sequelize.query(`SELECT DISTINCT account_id FROM analytics.${env.source} WHERE company_id = :companyId AND settled = false`, { replacements: { companyId }, transaction });
        return rows.map((r) => ({ account_id: r.account_id }));
      },
    },
  };
}

async function addSource(env, tenant, account, amount, { settled = true, due = '2026-12-31' } = {}) {
  await env.admin.query(`INSERT INTO analytics.${env.source} (company_id, account_id, amount, settled, due_date) VALUES (:c, :a, :m, :s, :d)`,
    { replacements: { c: tenant.companyId, a: account, m: amount, s: settled, d: due } });
}

function makeEvent(env, tenant, account, { id, occurredAt = new Date('2026-10-28T12:00:00Z'), eventType } = {}) {
  return {
    id: id || crypto.randomUUID(), eventType: eventType || env.settledType, companyId: tenant.companyId, groupId: tenant.groupId,
    aggregateId: account, payloadJson: { accountId: account }, occurredAt, retryCount: 0,
  };
}

async function readRow(env, tenant, account) {
  const [[row]] = await env.admin.query(`SELECT balance::text AS balance, overdue_count, source_snapshot_at, refreshed_at, version FROM analytics.${env.model} WHERE company_id = :c AND account_id = :a`,
    { replacements: { c: tenant.companyId, a: account } });
  return row || null;
}

/**
 * O job agendado de verdade (runAnalyticsReadModelRefreshJob) recalcula TODOS os read models registrados, em todas as empresas, com o relógio do teste, e grava
 * nas tabelas reais (rm_inventory_health, rm_legal_deadlines...) linhas com aquele instante, que os testes seguintes no mesmo banco leem (M9-D618/D619). O teste
 * do job só confere o read model dele: enquanto roda, os demais saem do registro e voltam depois, na mesma ordem. Devolve a função que os devolve.
 */
function onlyOwnModelInJob(env) {
  const others = readModels.listReadModels().filter((def) => def.name !== env.model);
  for (const def of others) readModels.unregisterReadModel(def.name);
  return () => { for (const def of others) if (!readModels.getReadModel(def.name)) readModels.registerReadModel(def); };
}

async function appliedCount(env, tenant) {
  const [[r]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m AND company_id = :c', { replacements: { m: env.model, c: tenant.companyId } });
  return r.n;
}

async function teardown(env) {
  readModels.unregisterReadModel(env.model);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM analytics.rm_applied_events WHERE read_model = :m', { replacements: { m: env.model }, transaction });
    await env.admin.query('DELETE FROM analytics.rm_stale_aggregates WHERE read_model = :m', { replacements: { m: env.model }, transaction });
    await env.admin.query('DELETE FROM analytics.read_model_refreshes WHERE read_model = :m', { replacements: { m: env.model }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type = :t", { replacements: { t: env.settledType }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.refresh.%'", { transaction }).catch(() => {});
  });
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.model}, analytics.${env.source}, analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

module.exports = { setup, teardown, onlyOwnModelInJob, addSource, makeEvent, readRow, appliedCount, inTx: sup.inTx, sfx: sup.sfx, sequelize };
