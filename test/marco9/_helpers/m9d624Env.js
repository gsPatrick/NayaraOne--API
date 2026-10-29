'use strict';

// Apoio dos testes da M9-D624 (KPIs de conciliações pendentes e anomalias): duas empresas NOVAS no grupo do seed (contagens independentes do
// que outros testes gravaram), relógio fixo, fontes do Financeiro por superusuário, refresh do read model e cálculo dos snapshots dos KPIs.
// Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`, por empresa.
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');
const ledger = require('./m9d615Ledger');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const AS_OF = '2026-10-28';
const FIN_TABLES = ['reconciliations', 'bank_transactions', 'bank_statement_imports', 'anomaly_cases'];
const KPIS = ['fin.reconciliations_pending', 'fin.anomalies_open'];

async function newCompany(env, label) {
  const id = ledger.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D624 ${label} ${id.slice(0, 6)}` } });
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

async function setup() {
  const base = await sup.setup();
  const env = { ...base, created: [], now: NOW, asOf: AS_OF };
  env.cX = await newCompany(env, 'X');
  env.cY = await newCompany(env, 'Y');
  return env;
}

async function teardown(env) {
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of FIN_TABLES) await env.admin.query(`DELETE FROM finance.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const t of ['rm_finance_health', 'rm_finance_sector_margin', 'rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  await env.admin.close();
  await sequelize.close();
}

const dayAt = (offset, hour = 15) => new Date(Date.UTC(2026, 9, 28 + offset, hour)).toISOString();

const bankTx = (env, t, { account, amount, date, createdAt }) => ledger.insert(env, 'bank_transactions', t, {
  bank_account_id: account, amount, transaction_date: date, ...(createdAt ? { created_at: createdAt } : {}),
});
const reconcile = (env, t, txId) => ledger.insert(env, 'reconciliations', t, { financial_entry_id: ledger.uuid(), bank_transaction_id: txId, matched_at: dayAt(0) });
const statementImport = (env, t, { account, createdAt }) => ledger.insert(env, 'bank_statement_imports', t, {
  bank_account_id: account, period_start: '2026-09-01', period_end: '2026-09-30', created_at: createdAt,
});
const anomaly = (env, t, { type = 'DUPLICATE', risk, status = 'OPEN', createdAt }) => ledger.insert(env, 'anomaly_cases', t, {
  case_type: type, risk_level: risk, reason: 'x', status, ...(createdAt ? { created_at: createdAt } : {}),
});

const event = (t, eventType = 'finance.reconciliation.matched') => ({
  id: ledger.uuid(), eventType, companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0,
});

/** Recalcula o read model rm_finance_health da empresa (worker de eventos) na data-base fixa. */
const refresh = (t, eventType) => sup.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event(t, eventType), tx, { now: NOW }));

/** Calcula e grava os snapshots dos KPIs financeiros da empresa. */
const kpis = (t, asOf = AS_OF) => sup.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));

const ctxOf = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:read'] });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

const healthRow = async (env, t, asOf = AS_OF) => (await env.admin.query('SELECT * FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: t.companyId, d: asOf } }))[0][0] || null;

const setSetting = (env, t, key, value) => env.admin.query(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  { replacements: { g: t.groupId, c: t.companyId, k: key, v: JSON.stringify(value) } }
);

module.exports = {
  setup, teardown, bankTx, reconcile, statementImport, anomaly, refresh, kpis, readKpi, healthRow, setSetting, ctxOf, dayAt, event, NOW, AS_OF, KPIS, inTx: sup.inTx, sequelize, ledger,
};
