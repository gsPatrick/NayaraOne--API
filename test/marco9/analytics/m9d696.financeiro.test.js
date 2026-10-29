'use strict';

// M9-D696 — checks do catálogo do read model do Financeiro (rm_finance_health): reconciliação com o ledger, tolerância, invariantes,
// completude, duplicidade de evento aplicado e o efeito DEGRADED. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d696Env');
const quality = require('../../../src/features/analytics/quality');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let env;
let tenant;
let lastEntryId;
const MODEL = 'rm_finance_health';
const scopeOf = () => ({ companyId: tenant.companyId, groupId: tenant.groupId });

before(async () => {
  env = await e.setup();
  tenant = env.tenantA;
  lastEntryId = await e.seedLedger(env, tenant);
  await e.applyAndRefresh(env, tenant, lastEntryId);
});
after(() => e.teardown(env));

const setParam = (key, value, who = tenant) => e.inTx(who, { commit: true }, (tx) => upsertSetting(key, value, who, who.userId, tx));
const clearParams = () => env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.qualidade.%'");
const state = () => e.inTx(tenant, {}, (tx) => quality.datasetQuality(MODEL, scopeOf(), tx));

test('m9d696 data quality falha e marca o dataset DEGRADED', async () => {
  const good = await e.check(env, tenant, MODEL);
  assert.equal(good.degraded, false, JSON.stringify(good.results.filter((r) => r.status !== 'PASSED')));
  assert.ok(good.results.every((r) => r.status === 'PASSED'));
  const types = new Set(good.results.map((r) => r.checkType));
  for (const t of ['COMPLETENESS', 'DUPLICATION', 'FRESHNESS', 'ROW_COUNT_RANGE', 'RECONCILIATION', 'INVARIANT', 'CONSISTENCY']) assert.ok(types.has(t), `falta o tipo ${t}`);
  assert.equal(e.statusOf(good, 'finance_health_free_cash_reconciliation').expected.value, '120000.00');
  assert.equal((await state()).status, 'OK');
  const rows = (await env.admin.query('SELECT * FROM analytics.data_quality_checks WHERE refresh_id = :r', { replacements: { r: good.refreshId } }))[0];
  assert.equal(rows.length, good.results.length, 'cada execução grava uma linha com expected, observed e status');
  assert.ok(rows.every((r) => r.company_id === tenant.companyId && r.expected && r.observed));

  // Divergência provocada: o read model diz 120.010,00 e o ledger diz 120.000,00.
  await e.setHealth(env, tenant, { free_cash: '120010.00' });
  const bad = await e.check(env, tenant, MODEL);
  const rec = e.statusOf(bad, 'finance_health_free_cash_reconciliation');
  assert.deepEqual([rec.status, rec.severity], ['FAILED', 'CRITICAL']);
  assert.equal(rec.observed.value, '120000.00');
  assert.equal(rec.observed.difference, '10.00');
  assert.deepEqual(rec.affectedMetricCodes.includes('fin.free_cash'), true);
  assert.equal(bad.degraded, true);
  assert.equal((await env.admin.query('SELECT status FROM analytics.read_model_refreshes WHERE id = :r', { replacements: { r: bad.refreshId } }))[0][0].status, 'DEGRADED');
  const degraded = await state();
  assert.equal(degraded.status, 'DEGRADED');
  assert.ok(degraded.affectedMetricCodes.includes('fin.free_cash'));

  // O refresh seguinte (read model corrigido) supera a falha anterior.
  await e.setHealth(env, tenant, { free_cash: '120000.00' });
  assert.equal((await e.check(env, tenant, MODEL)).degraded, false);
  assert.equal((await state()).status, 'OK');
});

test('m9d696 reconciliação detecta divergência de R$ 0,01', async () => {
  await clearParams();
  const run = async (freeCash) => { await e.setHealth(env, tenant, { free_cash: freeCash }); return e.statusOf(await e.check(env, tenant, MODEL), 'finance_health_free_cash_reconciliation'); };
  assert.equal((await run('120000.01')).status, 'PASSED', 'a tolerância padrão é R$ 0,01: diferir em MAIS de 0,01 reprova');
  const two = await run('120000.02');
  assert.deepEqual([two.status, two.observed.difference], ['FAILED', '0.02']);
  assert.equal((await run('119999.98')).status, 'FAILED', 'para menos também');

  await setParam('analytics.qualidade.tolerancia_conciliacao', 'R$ 0,00');
  const one = await run('120000.01');
  assert.deepEqual([one.status, one.observed.difference, one.expected.tolerance], ['FAILED', '0.01', '0.00'], 'com tolerância 0, 0,01 já é divergência');
  await setParam('analytics.qualidade.tolerancia_conciliacao', 'R$ 5,00');
  assert.equal((await run('120004.99')).status, 'PASSED', 'a tolerância é parâmetro');
  await clearParams();
  await e.setHealth(env, tenant, { free_cash: '120000.00' });
});

test('m9d696 invariante 7d <= 30d <= 60d', async () => {
  const code = 'finance_health_receivables_horizon_order';
  assert.equal(e.statusOf(await e.check(env, tenant, MODEL), code).status, 'PASSED', '10.000 <= 15.000 <= 17.000');
  await e.setHealth(env, tenant, { receivables_7d: '30000.00', receivables_30d: '28000.00' });
  const out = await e.check(env, tenant, MODEL);
  const inv = e.statusOf(out, code);
  assert.deepEqual([inv.status, inv.severity, inv.checkType], ['FAILED', 'CRITICAL', 'INVARIANT']);
  assert.deepEqual([inv.observed.receivables_7d, inv.observed.receivables_30d], ['30000.00', '28000.00']);
  assert.equal(out.degraded, true);
  await e.setHealth(env, tenant, { receivables_7d: '10000.00', receivables_30d: '15000.00', payables_30d: '1.00', payables_60d: '0.50' });
  assert.equal(e.statusOf(await e.check(env, tenant, MODEL), 'finance_health_payables_horizon_order').status, 'FAILED', 'o mesmo vale para as contas a pagar');
  await e.apply(tenant, e.makeEvent(tenant, 'finance.entry.settled', { id: lastEntryId, competenceMonth: '2026-10' }));
  assert.equal((await e.check(env, tenant, MODEL)).degraded, false, 'o recálculo pelo worker devolve o read model ao ledger');
});

test('m9d696 caixa livre mais terceiros bate com o caixa total do ledger', async () => {
  const code = 'finance_health_cash_split_consistency';
  assert.equal(e.statusOf(await e.check(env, tenant, MODEL), code).status, 'PASSED');
  await e.setHealth(env, tenant, { third_party_cash: '2900.00' });
  const bad = e.statusOf(await e.check(env, tenant, MODEL), code);
  assert.deepEqual([bad.status, bad.checkType, bad.expected.total, bad.observed.sum], ['FAILED', 'CONSISTENCY', '123000.00', '122900.00']);
  await e.setHealth(env, tenant, { third_party_cash: '3000.00' });
});

test('m9d696 completude do vencimento usa limite por campo e bloqueio', async () => {
  // Empresa B (o ledger é só de acréscimo: um lançamento sem vencimento fica para sempre e não pode sujar a empresa A).
  const B = env.tenantB;
  await clearParams();
  const code = 'finance_health_due_date_completeness';
  const run = async () => e.statusOf(await e.check(env, B, MODEL), code);
  assert.equal((await run()).status, 'PASSED', 'sem lançamentos pendentes não há o que medir');
  for (const days of [1, 2, 3, 4]) await e.ledger.entry(env, B, { nature: 'PAYABLE', amount: '10.00', status: 'PENDING', due: e.iso(days) });
  assert.equal((await run()).status, 'PASSED');
  await e.ledger.entry(env, B, { nature: 'PAYABLE', amount: '10.00', status: 'PENDING', due: null });
  const block = await run();
  assert.deepEqual([block.status, block.severity, block.checkType], ['FAILED', 'CRITICAL', 'COMPLETENESS'], '1 em 5 pendentes (20%) passa dos 5% de bloqueio');
  assert.equal(block.observed.pct, 20);
  await setParam('analytics.qualidade.max_nulos_bloqueio_pct', 50, B);
  const warn = await run();
  assert.deepEqual([warn.status, warn.severity], ['FAILED', 'WARNING'], 'acima do limite do campo (0%) e abaixo do bloqueio: WARN');
  await setParam('analytics.qualidade.max_nulos_pct.due_at', 20, B);
  assert.equal((await run()).status, 'PASSED', 'o limite por campo é parâmetro');
  await clearParams();
});

test('m9d696 duplicidade do mesmo evento com a caixa do identificador diferente', async () => {
  const eventId = '0f4b1c2e-aaaa-bbbb-cccc-0123456789ab';
  const sql = (id) => env.admin.query(
    "INSERT INTO analytics.rm_applied_events (read_model, source_event_id, company_id, group_id, aggregate_id) VALUES ('rm_finance_health', :id, :c, :g, 'x')",
    { replacements: { id, c: tenant.companyId, g: tenant.groupId } }
  );
  await sql(eventId);
  assert.equal(e.statusOf(await e.check(env, tenant, MODEL), 'finance_health_applied_event_duplication').status, 'PASSED');
  await sql(eventId.toUpperCase()); // a PK enxerga dois textos; é o mesmo evento aplicado duas vezes
  const bad = await e.check(env, tenant, MODEL);
  const dup = e.statusOf(bad, 'finance_health_applied_event_duplication');
  assert.deepEqual([dup.status, dup.severity, dup.observed.duplicates], ['FAILED', 'CRITICAL', 1]);
  assert.equal(bad.degraded, true);
  await env.admin.query("DELETE FROM analytics.rm_applied_events WHERE read_model = 'rm_finance_health' AND lower(source_event_id) = :id", { replacements: { id: eventId } });
});

test('m9d696 o fim do lote do worker roda os checks sozinho', async () => {
  const ids = [];
  for (const amount of ['7.00', '8.00']) ids.push(await e.ledger.entry(env, tenant, { nature: 'PAYABLE', amount, status: 'PENDING', due: e.iso(4) }));
  const flushed = await e.applyAndRefresh(env, tenant, ids[0]);
  const checks = (await env.admin.query('SELECT check_code, status FROM analytics.data_quality_checks WHERE refresh_id = :r', { replacements: { r: flushed.id } }))[0];
  assert.ok(checks.length >= 6, 'o listener de fim de lote da D607 chamou a D696 sem ninguém pedir');
  assert.ok(checks.every((c) => c.status === 'PASSED'), JSON.stringify(checks));
});

test('m9d696 isolamento: cada check fica na empresa do refresh que o motivou', async () => {
  const [[n]] = await env.admin.query(`SELECT count(*)::int AS n FROM analytics.data_quality_checks q JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
    WHERE q.company_id IS DISTINCT FROM r.company_id OR q.group_id IS DISTINCT FROM r.group_id`);
  assert.equal(n.n, 0);
  const [[b]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.data_quality_checks WHERE company_id = :c AND read_model = :m AND check_code = :k',
    { replacements: { c: env.tenantB.companyId, m: MODEL, k: 'finance_health_free_cash_reconciliation' } });
  assert.ok(b.n >= 1, 'a empresa B tem as suas próprias linhas');
});
