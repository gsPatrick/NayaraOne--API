'use strict';

// Apoio dos testes dos read models de Comercial/Imóveis e Locação (M9-D616, M9-D617): duas empresas NOVAS no grupo de seed (a contagem de
// cada teste não depende do que o seed ou outros testes gravaram), relógio fixo, eventos do outbox simulados e leitura das linhas.
// Banco descartável (127.0.0.1). Tudo o que o teste grava com commit é apagado em `teardown`, por empresa.
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const src = require('./biSources');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const TODAY = '2026-10-28';

const SOURCE_TABLES = [
  'crm.messages', 'crm.visits', 'crm.proposals', 'crm.feedback_cases', 'crm.opportunities', 'real_estate.property_price_history', 'real_estate.property_offers', 'real_estate.properties',
  'legal.key_deliveries', 'legal.inspections', 'legal.guarantees', 'legal.contract_requirements', 'legal.contract_parties', 'legal.contracts', 'legal.lease_obligations',
  'finance.owner_repasses', 'finance.financial_entries', 'construction.maintenance_cases', 'construction.projects',
];

async function newCompany(env, label) {
  const id = src.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 BI ${label} ${id.slice(0, 6)}` } });
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

async function setup() {
  const base = await sup.setup();
  const env = { ...base, now: NOW, today: TODAY };
  env.cX = await newCompany(env, 'X');
  env.cY = await newCompany(env, 'Y');
  return env;
}

async function teardown(env) {
  const ids = [env.cX.companyId, env.cY.companyId];
  const models = readModels.listReadModels().map((d) => d.name).filter((n) => /^rm_(crm|property|radar|broker|rental)/.test(n));
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of SOURCE_TABLES) await env.admin.query(`DELETE FROM ${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE company_id IN (:ids)", { replacements: { ids }, transaction });
    for (const m of models) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

function makeEvent(tenant, eventType, payload = {}, { id, occurredAt } = {}) {
  return { id: id || src.uuid(), eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: payload.id || src.uuid(), payloadJson: payload, occurredAt: occurredAt || NOW, retryCount: 0 };
}

/** Aplica o evento ao worker numa transação do tenant (com commit) e devolve o resumo. */
const apply = (tenant, event, options = {}) => sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW, ...options }));

/** Passada da agenda da empresa no instante dado. */
const runSchedule = (tenant, now = NOW) => sup.inTx(tenant, { commit: true }, async (tx) => {
  const params = await readModels.readRefreshParams(tenant, tx);
  return readModels.refreshCompanyScheduled({ companyId: tenant.companyId, groupId: tenant.groupId }, params, tx, { now });
});

/** Linhas do read model da empresa (conexão de superusuário); a ordem padrão é a das colunas da chave (3ª em diante). */
async function rows(env, model, tenant, order = '3, 4, 5') {
  const [list] = await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY ${order}`, { replacements: { c: tenant.companyId } });
  return list;
}

const pick = (list, where) => list.find((r) => Object.entries(where).every(([k, v]) => String(r[k]) === String(v)));
const setSetting = (env, tenant, key, value) => env.admin.query(
  "INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value",
  { replacements: { g: tenant.groupId, c: tenant.companyId, k: key, v: JSON.stringify(value) } }
);

module.exports = { setup, teardown, makeEvent, apply, runSchedule, rows, pick, setSetting, NOW, TODAY, inTx: sup.inTx, sequelize, src };
