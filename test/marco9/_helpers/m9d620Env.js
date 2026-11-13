'use strict';

// Apoio dos testes da M9-D620 (KPIs fin.free_cash e fin.third_party_cash): duas empresas NOVAS no grupo do seed (valores independentes do que outros
// testes gravaram), relógio fixo, fontes do Financeiro por superusuário, refresh do read model e cálculo dos snapshots. Banco descartável (127.0.0.1).
// Tudo o que o teste grava é apagado em `teardown`, por empresa.
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');
const ledger = require('./m9d615Ledger');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const AS_OF = '2026-10-28';
const KPIS = ['fin.free_cash', 'fin.third_party_cash'];
const FIN_TABLES = ['reconciliations', 'bank_transactions', 'bank_statement_imports', 'intercompany_transfers', 'financial_entries', 'bank_accounts'];

async function newCompany(env, label) {
  const id = ledger.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D620 ${label} ${id.slice(0, 6)}` } });
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

/** Lançamento liquidado (por padrão) com os campos que o caixa lê. `c`: { nature, amount, status, settled, third, reference, release, origin, account, center, review, reversalOf, key, type }. */
const entry = (env, t, c) => ledger.insert(env, 'financial_entries', t, {
  entry_type: c.type || (c.nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT'), nature: c.nature, amount: c.amount, status: c.status || 'SETTLED',
  settled_at: c.settled === undefined ? dayAt(-1) : c.settled, due_at: c.due || null, is_third_party_funds: Boolean(c.third), third_party_reference: c.reference || null,
  third_party_release_type: c.release || null, third_party_origin_entry_id: c.origin || null, bank_account_id: c.account || null, cost_center_id: c.center || null,
  requires_manual_review: Boolean(c.review), manual_review_cleared_at: c.reviewCleared || null, reversal_of_entry_id: c.reversalOf || null, idempotency_key: c.key || null,
});

const account = (env, t, { opening = '0.00', owner = null } = {}) => ledger.insert(env, 'bank_accounts', t, { opening_balance: opening, status: 'ACTIVE', owner_person_id: owner });
const statementImport = (env, t, { account: acc, closing, start = '2026-09-01', end = '2026-09-30' }) => ledger.insert(env, 'bank_statement_imports', t, {
  bank_account_id: acc, period_start: start, period_end: end, closing_balance: closing, created_at: dayAt(-1),
});
// Id do provedor próprio por linha: o extrato é UNIQUE(conta, fingerprint) sem condição desde a conciliação do Marco 4 (Guia M4 §10).
const bankTx = (env, t, { account: acc, amount, date }) => ledger.insert(env, 'bank_transactions', t, { bank_account_id: acc, amount, transaction_date: date, external_transaction_id: `m9d620-${ledger.uuid()}` });
const reconcile = (env, t, txId) => ledger.insert(env, 'reconciliations', t, { financial_entry_id: ledger.uuid(), bank_transaction_id: txId, matched_at: dayAt(0) });

const event = (t, eventType = 'finance.entry.settled') => ({
  id: ledger.uuid(), eventType, companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0,
});

/** Recalcula o read model rm_finance_health da empresa (worker de eventos) na data-base fixa. */
const refresh = (t, eventType) => sup.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event(t, eventType), tx, { now: NOW }));
/** Calcula e grava os snapshots dos KPIs financeiros da empresa. */
const kpis = (t, asOf = AS_OF) => sup.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));
const ctxOf = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:read'] });
/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
// A coluna do snapshot é numeric(20,4): o valor lido volta com 4 casas; os testes comparam em reais com 2 casas (o KPI só tem 2).
const twoPlaces = (kpi) => ({ ...kpi, value: kpi.value === null || kpi.value === undefined ? null : money.money(kpi.value) });
const readKpi = async (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => twoPlaces(await sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx)));
/** refresh + cálculo + leitura dos dois KPIs. */
async function run(t) {
  await refresh(t);
  await kpis(t);
  return { free: await readKpi(t, 'fin.free_cash'), third: await readKpi(t, 'fin.third_party_cash') };
}

const healthRow = async (env, t, asOf = AS_OF) => (await env.admin.query('SELECT * FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: t.companyId, d: asOf } }))[0][0] || null;
const setSetting = (env, t, key, value) => env.admin.query(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST(:v AS jsonb)) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  { replacements: { g: t.groupId, c: t.companyId, k: key, v: JSON.stringify(value) } }
);

module.exports = {
  money, setup, teardown, entry, account, statementImport, bankTx, reconcile, refresh, kpis, readKpi, run, healthRow, setSetting, ctxOf, dayAt, event, NOW, AS_OF, KPIS, inTx: sup.inTx, sequelize, ledger,
};
