'use strict';

// M9-D620 — GET /v1/analytics/metrics/<código> dos dois KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const { cashFromSource } = require('../_helpers/m9d620Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const readModels = require('../../../src/features/analytics/read-models');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read'];
const CODES = "(SELECT metric_code FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'fin.%')"; // o refresh publica TODOS os KPIs financeiros da empresa: limpa todos os dela
const dayAt = (n) => new Date(Date.UTC(2026, 9, 28 + n, 15)).toISOString();
let env;
let src;
const row = (nature, amount, extra = {}) => ledger.insert(src, 'financial_entries', env.tenantA, {
  entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, amount, status: 'SETTLED', settled_at: dayAt(-1), is_third_party_funds: false, ...extra,
});

before(async () => {
  env = await http.setup();
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const acc = await ledger.insert(src, 'bank_accounts', t, { opening_balance: '10000.00', status: 'ACTIVE' });
  await row('RECEIVABLE', '100000.00', { bank_account_id: acc });
  await row('RECEIVABLE', '8000.00', { is_third_party_funds: true, third_party_reference: 'Caução contrato 1', bank_account_id: acc });
  await row('RECEIVABLE', '27000.00', { is_third_party_funds: true, third_party_reference: 'Repasse ao proprietário', bank_account_id: acc });
  await row('PAYABLE', '20000.00', { bank_account_id: acc });
  const event = { id: ledger.uuid(), eventType: 'finance.entry.settled', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0 };
  await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
  await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  const ids = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const [table, list] of Object.entries(src.created.reduce((m, r) => ({ ...m, [r.table]: [...(m[r.table] || []), r.id] }), {}))) {
      await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:list)`, { replacements: { list }, transaction });
    }
    await env.admin.query('DELETE FROM finance.bank_accounts WHERE company_id = :c AND opening_balance = 10000', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ' + CODES + ')', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ' + CODES + ')', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN ' + CODES, { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ' + CODES, { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

test('m9d620 GET /analytics/metrics/fin.free_cash devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('fin.free_cash');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  const want = await cashFromSource({ admin: env.admin }, env.tenantA, AS_OF);
  assert.equal(money.money(d.value), want.freeCash);
  assert.equal(money.money(d.value), '90000.00');
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode], ['BRL', 'OK', 1, 'fin.free_cash']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.equal(d.sourceRefs[0].table, 'finance.financial_entries');
  assert.equal(d.sourceRefs[0].reconcileMode, 'SUM');
  assert.equal(d.sourceRefs[0].restricted, true, 'sem analytics:drilldown não vêm ids');
});

test('m9d620 GET /analytics/metrics/fin.third_party_cash devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('fin.third_party_cash');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  const want = await cashFromSource({ admin: env.admin }, env.tenantA, AS_OF);
  assert.equal(money.money(d.value), want.terceirosRetidos);
  assert.equal(money.money(d.value), '35000.00');
  assert.deepEqual([d.unit, d.status, d.version], ['BRL', 'OK', 1]);
  assert.equal(d.sourceRefs[0].count, 2, 'o sourceRefs conta as duas entradas de terceiros');
  const livre = Number((await get('fin.free_cash')).body.data.value);
  assert.equal(livre + Number(d.value), 125000, 'caixa livre + terceiros = caixa total');
});

test('m9d620 isolamento entre empresas: empresa de outro grupo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor nunca aparece', async () => {
  const res = await get('fin.free_cash', { tenant: 'B', query: `asOf=${AS_OF}&companyId=${env.tenantA.companyId}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(res.body), /90000/);
  const own = await get('fin.free_cash', { tenant: 'B' });
  assert.notEqual(own.status, 200, 'a empresa B não tem o KPI nem o snapshot da A');
});

test('m9d620 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.free_cash', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('fin.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('fin.free_cash', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
