'use strict';

// Apoio dos testes dos KPIs de Obras (M9-D652) e de Estoque e Patrimônio (M9-D653): duas empresas NOVAS no grupo do seed (contagens independentes do que
// outros testes gravaram), relógio fixo em 28/10/2026 12:00 de São Paulo, fontes por superusuário (sem FK, só o que o teste precisa), eventos do outbox
// simulados, cálculo dos snapshots dos KPIs e a leitura como a API lê. Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`.
const crypto = require('node:crypto');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const clock = require('../../../src/features/analytics/metrics/clock');
require('../../../src/features/analytics');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const AS_OF = '2026-10-28';
const uuid = () => crypto.randomUUID();
const MODELS = [
  'rm_project_waste', 'rm_postwork_cost', 'rm_project_cost', 'rm_project_occurrences', 'rm_project_nonconformities', 'rm_project_progress', 'rm_project_delays',
  'rm_project_measurements', 'rm_inventory_health', 'rm_tool_assets',
];
const SOURCES = [
  'construction.warranty_actions', 'construction.maintenance_cases', 'construction.nonconformities', 'construction.project_stages', 'construction.projects', 'construction.budgets',
  'inventory.inventory_movements', 'inventory.loss_cases', 'inventory.stock_balances', 'inventory.inventory_items', 'inventory.tool_loans', 'inventory.maintenance_orders',
  'inventory.assets', 'legal.contracts', 'finance.financial_entries',
];
const CODES = ['obra.waste', 'obra.postwork_cost', 'obra.recurrence', 'inv.stock_value', 'inv.below_minimum', 'inv.losses', 'inv.tools_overdue'];

async function newCompany(env, label) {
  const id = uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D652 ${label} ${id.slice(0, 6)}` } });
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

async function setup() {
  const base = await sup.setup();
  clock.setClock(NOW);
  const env = { ...base, created: [], now: NOW, asOf: AS_OF };
  env.cX = await newCompany(env, 'X');
  env.cY = await newCompany(env, 'Y');
  return env;
}

async function teardown(env) {
  clock.resetClock();
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of SOURCES) await env.admin.query(`DELETE FROM ${table} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const t of [...MODELS, 'rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  await env.admin.close();
  await sequelize.close();
}

/** Grava uma linha da fonte (schema.tabela) para o tenant; devolve o id. */
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

const update = (env, table, id, set) => env.admin.query(`UPDATE ${table} SET ${Object.keys(set).map((n) => `"${n}" = :${n}`).join(', ')} WHERE id = :id`, { replacements: { ...set, id } });

const event = (t, eventType, payload = {}) => ({ id: uuid(), eventType, companyId: t.companyId, groupId: t.groupId, aggregateId: payload.id || uuid(), payloadJson: payload, occurredAt: NOW, retryCount: 0 });

/** Aplica o evento a todos os read models que o consomem (worker do BI), numa transação do tenant com commit. */
const apply = (t, eventType, payload, options = {}) => sup.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event(t, eventType, payload), tx, { now: NOW, ...options }));

const GROUPS = { obra: kpis.obraPerdasKpis, inv: kpis.estoqueKpis };

/** Calcula e grava os snapshots do grupo ('obra' ou 'inv') para a data-base. Devolve { kpis: { código: resultado }, written }. */
const run = (t, group, asOf = AS_OF) => sup.inTx(t, { commit: true }, (tx) => GROUPS[group].materialize({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));

const ctxOf = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:read'] });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t), { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

const setSetting = (env, t, key, value) => env.admin.query(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  { replacements: { g: t.groupId, c: t.companyId, k: key, v: JSON.stringify(value) } }
);

const rowsOf = async (env, model, t) => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 1, 2, 3, 4, 5`, { replacements: { c: t.companyId } }))[0];

module.exports = { NOW, AS_OF, MODELS, CODES, uuid, setup, teardown, seed, update, event, apply, run, ctxOf, readKpi, setSetting, rowsOf, inTx: sup.inTx, sequelize, registry, kpis, readModels, clock };
