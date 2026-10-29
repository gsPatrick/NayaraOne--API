'use strict';

// M9-D708 (3.3) — reconciliação por KPI: o valor do BI contra o do relatório de referência, a diferença gravada em PENDING, o caixa livre contra o
// relatório de saúde financeira (getWeeklyHealthReport) em massa de teste e a cobertura de todos os KPIs do registro. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e708 = require('../_helpers/m9d708Env');
const reconcile = require('../../../src/features/analytics/metrics/acceptance.reconcile');
const { REFERENCE_REPORTS } = require('../../../scripts/analytics/reconcile/reports');
require('../../../src/features/analytics');

const { entry, account, bankTx, run, dayAt, AS_OF, NOW } = e708;
let env;
before(async () => { env = await e708.setup(); });
after(() => e708.teardown(env));

const opts = (extra = {}) => ({ asOfDate: AS_OF, now: NOW, referenceReports: REFERENCE_REPORTS, ...extra });
const reconcileOne = (t, code, extra) => e708.inTx(t, { commit: true }, (tx) => reconcile.reconcileMetric(e708.ctxFor(t, env.ownerUserId), code, opts(extra), tx));
const reconcileAll = (t) => e708.inTx(t, { commit: true }, (tx) => reconcile.reconcileAll(e708.ctxFor(t, env.ownerUserId), opts(), tx));

/** Massa de teste: o razão e o extrato bancário contam a mesma história (entrada 100.000, saída 20.000, caução de terceiros 8.000 recebida e retida). */
async function massa(t) {
  const acc = await account(env, t, { opening: '0.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100000.00', account: acc, settled: dayAt(-3) });
  await entry(env, t, { nature: 'PAYABLE', amount: '20000.00', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '8000.00', third: true, reference: 'Caução contrato 12', account: acc, settled: dayAt(-2) });
  await bankTx(env, t, { account: acc, amount: '100000.00', date: '2026-10-25' });
  await bankTx(env, t, { account: acc, amount: '-20000.00', date: '2026-10-27' });
  await bankTx(env, t, { account: acc, amount: '8000.00', date: '2026-10-26' });
  // contas a pagar e a receber em aberto para as janelas e os vencidos
  await entry(env, t, { nature: 'PAYABLE', amount: '1500.00', status: 'PENDING', settled: null, due: dayAt(2) });
  await entry(env, t, { nature: 'PAYABLE', amount: '700.00', status: 'PENDING', settled: null, due: dayAt(-2) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '900.00', status: 'PENDING', settled: null, due: dayAt(10) });
}

test('m9d708 reconciliação do caixa livre bate com o relatório de saúde financeira em massa de teste', async () => {
  const t = env.cX;
  await massa(t);
  await run(t);
  const r = await reconcileOne(t, 'fin.free_cash');
  assert.equal(r.biValue, '80000.00');
  assert.equal(r.referenceValue, '80000.00', 'o relatório de saúde financeira (saldo bancário menos terceiros retidos)');
  assert.equal(r.difference, '0.00');
  assert.equal(r.status, 'PENDING');
  assert.match(r.referenceReport, /getWeeklyHealthReport/);
  const row = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.deepEqual([row.bi_value, row.reference_value, row.difference, row.status, row.metric_version], ['80000.00', '80000.00', '0.00', 'PENDING', 1]);
  assert.equal(row.tolerance, '0.00', 'a tolerância vigente fica gravada com a linha (padrão 0 para dinheiro)');
  assert.ok(row.reference_report.length > 20);
});

test('m9d708 reconciliação grava diferença por KPI', async () => {
  const t = env.cX;
  await bankTx(env, t, { account: (await env.admin.query('SELECT id FROM finance.bank_accounts WHERE company_id = :c LIMIT 1', { replacements: { c: t.companyId } }))[0][0].id, amount: '10.00', date: '2026-10-27' });
  const r = await reconcileOne(t, 'fin.free_cash');
  assert.equal(r.biValue, '80000.00');
  assert.equal(r.referenceValue, '80010.00');
  assert.equal(r.difference, '-10.00', 'diferença = BI - relatório');
  const row = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.equal(row.difference, '-10.00');
  assert.equal(row.status, 'PENDING');
});

test('m9d708 as janelas, os vencidos e a necessidade de respirar também batem com o relatório de saúde financeira', async () => {
  const t = env.cX;
  await reconcileAll(t);
  for (const code of ['fin.payables_7d', 'fin.payables_30d', 'fin.receivables_30d', 'fin.overdue_receivables', 'fin.third_party_cash', 'fin.breathing_need']) {
    const row = await e708.acceptanceRow(env, t, code, 1);
    assert.ok(row, code);
    assert.equal(row.difference, '0.00', `${code}: BI ${row.bi_value} x relatório ${row.reference_value}`);
    assert.match(row.reference_report, /getWeeklyHealthReport/, code);
  }
  assert.equal((await e708.acceptanceRow(env, t, 'fin.payables_7d', 1)).bi_value, '1500.00');
  const pending = await e708.acceptanceRow(env, t, 'fin.reconciliations_pending', 1);
  assert.equal(pending.reference_value, '4.00', 'o relatório de saúde conta as transações do extrato sem conciliação');
  const breathing = await e708.acceptanceRow(env, t, 'fin.breathing_need', 1);
  assert.match(breathing.reference_report, /comiss/, 'a necessidade de respirar usa as comissões sem lançamento do componente');
});

test('m9d708 cada KPI publicado ganha relatório de referência e uma linha de reconciliação', async () => {
  const t = env.cX;
  const results = await reconcileAll(t);
  const [defs] = await env.admin.query("SELECT metric_code FROM analytics.metric_definitions WHERE company_id = :c AND status = 'PUBLISHED'", { replacements: { c: t.companyId } });
  assert.ok(defs.length >= 15, `${defs.length} KPIs financeiros publicados`);
  assert.deepEqual(results.map((r) => r.metricCode).sort(), defs.map((d) => d.metric_code).sort());
  const [rows] = await env.admin.query("SELECT metric_code, reference_report, metric_version, status FROM analytics.metric_acceptance WHERE company_id = :c", { replacements: { c: t.companyId } });
  assert.equal(rows.length, defs.length, 'nenhum KPI sem linha');
  for (const row of rows) {
    assert.ok(row.reference_report && row.reference_report.trim().length > 10, `${row.metric_code}: relatório de referência`);
    assert.equal(row.status, 'PENDING');
  }
});

test('m9d708 a origem registrada confere os KPIs sem relatório de outra área contra as linhas do módulo', async () => {
  const t = env.cX;
  for (const code of ['fin.anomalies_open', 'fin.commissions_paid', 'fin.owner_repasses_pending']) {
    const row = await e708.acceptanceRow(env, t, code, 1);
    assert.equal(row.reference_value, '0.00', code);
    assert.match(row.reference_report, /Origem /, `${code}: o relatório é a origem registrada`);
  }
});

test('m9d708 rodar de novo atualiza a linha da mesma versão em vez de duplicar e volta a PENDING', async () => {
  const t = env.cX;
  const before = (await env.admin.query('SELECT count(*)::int AS n FROM analytics.metric_acceptance WHERE company_id = :c', { replacements: { c: t.companyId } }))[0][0].n;
  const file = await e708.evidenceFile(env, t);
  await env.admin.query("UPDATE analytics.metric_acceptance SET status = 'ACCEPTED', accepted_by = :u, accepted_at = now(), evidence_file_id = :f WHERE company_id = :c AND metric_code = 'fin.payables_7d'", { replacements: { u: env.ownerUserId, c: t.companyId, f: file } });
  await reconcileOne(t, 'fin.payables_7d');
  const after1 = (await env.admin.query('SELECT count(*)::int AS n FROM analytics.metric_acceptance WHERE company_id = :c', { replacements: { c: t.companyId } }))[0][0].n;
  assert.equal(after1, before);
  const row = await e708.acceptanceRow(env, t, 'fin.payables_7d', 1);
  assert.deepEqual([row.status, row.accepted_by, row.accepted_at, row.evidence_file_id], ['PENDING', null, null, null], 'novo cálculo invalida a decisão anterior da mesma versão');
});

test('m9d708 todo KPI do registro tem o relatório de referência (adaptador do relatório ou origem registrada)', async () => {
  const [defs] = await env.admin.query('SELECT DISTINCT metric_code FROM analytics.metric_definitions');
  assert.ok(defs.length >= 90);
  const missing = defs.map((d) => d.metric_code).filter((code) => !/\.m9d\d+_/.test(code)) // sobras sintéticas de outros testes não são KPI do registro
    .filter((code) => !reconcile.hasReference(code, REFERENCE_REPORTS));
  assert.deepEqual(missing, [], 'KPI sem relatório de referência');
});

test('m9d708 KPI sem snapshot na data-base fica PENDING com o motivo e sem diferença (o aceite não passa)', async () => {
  const t = env.cX;
  const r = await reconcileOne(t, 'fin.free_cash', { asOfDate: '2026-01-05' });
  assert.equal(r.biValue, null);
  assert.equal(r.difference, null);
  assert.match(r.comment, /sem valor do BI/i);
});

test('m9d708 métrica de outra empresa responde 404 e a leitura não vaza entre empresas', async () => {
  const t = env.cY;
  await assert.rejects(reconcileOne(t, 'fin.metrica_que_nao_existe'), (e) => e.statusCode === 404 && e.code === 'ANALYTICS_METRIC_NOT_FOUND');
  const rows = await e708.inTx(t, {}, (tx) => e708.sequelize.query('SELECT 1 FROM analytics.metric_acceptance WHERE company_id = :c', { replacements: { c: env.cX.companyId }, transaction: tx }));
  assert.equal(rows[0].length, 0);
});
