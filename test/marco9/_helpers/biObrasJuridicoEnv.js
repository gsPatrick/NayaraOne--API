'use strict';

// Apoio dos testes dos read models do BI de Obras, Estoque, Jurídico e Correspondente (M9-D618, M9-D619): tenants, relógio fixo, gravação de
// fontes por conexão de superusuário (sem FK, só o que o teste precisa), eventos do outbox simulados e leitura das linhas por read model.
// Banco descartável (127.0.0.1). Tudo o que o teste grava com commit é removido em `teardown`.
const crypto = require('node:crypto');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const clock = require('../../../src/features/analytics/metrics/clock');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const AS_OF = '2026-10-28';
const uuid = () => crypto.randomUUID();

async function setup(models) {
  const base = await sup.setup();
  clock.setClock(NOW);
  return { ...base, models, created: [], now: NOW, asOf: AS_OF };
}

/** Grava uma linha da fonte (schema.tabela) para o tenant; devolve o id. Registra para a limpeza. */
async function seed(env, tenant, table, columns) {
  const row = { id: uuid(), group_id: tenant.groupId, company_id: tenant.companyId, ...columns };
  const names = Object.keys(row);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query(`INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`, { replacements: row, transaction });
  });
  env.created.push({ table, id: row.id });
  return row.id;
}

async function update(env, table, id, set) {
  const names = Object.keys(set);
  await env.admin.query(`UPDATE ${table} SET ${names.map((n) => `"${n}" = :${n}`).join(', ')} WHERE id = :id`, { replacements: { ...set, id } });
}

async function teardown(env) {
  clock.resetClock();
  const companies = [env.tenantA.companyId, env.tenantB.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    for (const model of env.models) {
      await env.admin.query(`DELETE FROM analytics.${model} WHERE company_id IN (:companies)`, { replacements: { companies }, transaction });
      for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
        await env.admin.query(`DELETE FROM analytics.${t} WHERE read_model = :model`, { replacements: { model }, transaction });
      }
    }
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.obra.%' OR key LIKE 'analytics.estoque.%' OR key LIKE 'analytics.juridico.%'", { transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE event_type = 'analytics.read_model.rebuilt' AND company_id IN (:companies)", { replacements: { companies }, transaction });
  });
  await env.admin.close();
  await sequelize.close();
}

function makeEvent(tenant, eventType, payload = {}, { id } = {}) {
  return { id: id || uuid(), eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: payload.id || uuid(), payloadJson: payload, occurredAt: NOW, retryCount: 0 };
}

/** Aplica o evento a todos os read models que o consomem, numa transação do tenant (com commit); devolve o resumo do worker. */
const apply = (tenant, event, options = {}) => sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW, ...options }));

/** Linhas do read model da empresa, ordenadas pela chave, para comparação estável. */
async function rowsOf(env, model, tenant) {
  const def = readModels.getReadModel(model);
  const [rows] = await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY ${def.keyColumns.map((c) => `"${c}"::text`).join(', ')}`, { replacements: { c: tenant.companyId } });
  return rows;
}

const setSetting = (env, tenant, key, value) => env.admin.query(
  `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb))
   ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
  { replacements: { g: tenant.groupId, c: tenant.companyId, k: key, v: JSON.stringify(value) } }
);

/** Roda a passada agendada da empresa no instante dado (sem nenhum evento: só a passagem do tempo). */
const runSchedule = (tenant, now) => sup.inTx(tenant, { commit: true }, async (tx) => readModels.refreshCompanyScheduled(
  { companyId: tenant.companyId, groupId: tenant.groupId }, await readModels.readRefreshParams(tenant, tx), tx, { now }
));

module.exports = { NOW, AS_OF, uuid, setup, teardown, seed, update, makeEvent, apply, rowsOf, setSetting, runSchedule, inTx: sup.inTx, sequelize, readModels, clock };
