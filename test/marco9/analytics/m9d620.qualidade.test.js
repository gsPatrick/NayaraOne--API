'use strict';

// M9-D620 — regras de qualidade: o caixa livre sai DEGRADED com valor nulo quando há lançamento em revisão manual ou o caixa do ledger diverge
// do saldo da última conciliação bancária conciliada; o dinheiro de terceiros sai DEGRADED quando a liberação passa da entrada.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e620 = require('../_helpers/m9d620Env');
require('../../../src/features/analytics');
const quality = require('../../../src/features/analytics/quality');
const refreshStore = require('../../../src/features/analytics/readModelRefreshStore.service');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');

const { entry, account, statementImport, bankTx, reconcile, run, dayAt, setSetting } = e620;
let env;
before(async () => { env = await e620.setup(); });
after(() => e620.teardown(env));

test('m9d620 fin.free_cash fica DEGRADED com valor nulo quando a regra de qualidade falha (revisão manual pendente)', async () => {
  const t = env.cX;
  await entry(env, t, { nature: 'RECEIVABLE', amount: '1000.00', settled: dayAt(-1) });
  const flagged = await entry(env, t, { nature: 'PAYABLE', amount: '10.00', status: 'PENDING', settled: null, review: true });
  const degraded = (await run(t)).free;
  assert.equal(degraded.value, null, 'nunca um número enganoso');
  assert.equal(degraded.status, 'DEGRADED');
  assert.equal((await e620.healthRow(env, t)).manual_review_pending, 1);
  await e620.ledger.update(env, 'financial_entries', flagged, { manual_review_cleared_at: dayAt(0, 12) });
  const cleared = (await run(t)).free;
  assert.deepEqual([cleared.value, cleared.status], ['1000.00', 'OK'], 'liberada a revisão, o número volta');
});

test('m9d620 fin.free_cash fica DEGRADED quando o caixa do ledger difere do saldo da última conciliação bancária', async () => {
  const t = env.cY;
  const acc = await account(env, t, { opening: '500.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '1000.00', account: acc, settled: dayAt(-40) });
  await entry(env, t, { nature: 'PAYABLE', amount: '200.00', account: acc, settled: dayAt(-35) });
  const tx = await bankTx(env, t, { account: acc, amount: '800.00', date: dayAt(-38) });
  await reconcile(env, t, tx);
  const imp = await statementImport(env, t, { account: acc, closing: '1300.00' }); // ledger: 500 + 1000 - 200 = 1300
  assert.equal((await run(t)).free.status, 'OK', 'ledger e extrato iguais');
  assert.equal((await e620.healthRow(env, t)).reconciliation_gap, '0.00');

  await e620.ledger.update(env, 'bank_statement_imports', imp, { closing_balance: '1300.01' });
  const edge = (await run(t)).free;
  assert.deepEqual([edge.status, edge.value], ['OK', '1300.00'], 'diferença igual à tolerância (R$ 0,01) ainda vale');

  await e620.ledger.update(env, 'bank_statement_imports', imp, { closing_balance: '1299.50' });
  const bad = (await run(t)).free;
  assert.equal(bad.status, 'DEGRADED');
  assert.equal(bad.value, null);
  assert.equal((await e620.healthRow(env, t)).reconciliation_gap, '0.50');

  await setSetting(env, t, 'analytics.qualidade.tolerancia_conciliacao', 'R$ 1,00');
  assert.equal((await run(t)).free.status, 'OK', 'a tolerância é parâmetro do administrador (analytics.qualidade.tolerancia_conciliacao)');
});

test('m9d620 extrato com transação ainda sem conciliação não é "conciliado": não entra na conferência', async () => {
  const t = env.cY;
  const acc = await account(env, t, { opening: '0.00' });
  await bankTx(env, t, { account: acc, amount: '10.00', date: dayAt(-38) });
  await statementImport(env, t, { account: acc, closing: '99999.00', start: '2026-09-01', end: '2026-09-30' });
  const { free } = await run(t);
  assert.equal((await e620.healthRow(env, t)).reconciliation_gap_accounts, 1, 'só a conta do teste anterior tem extrato conciliado');
  assert.equal(free.status, 'OK', 'o extrato de R$ 99.999,00 da conta com transação sem conciliação não degrada o caixa');
});

test('m9d620 fin.third_party_cash fica DEGRADED com valor nulo quando a regra de qualidade falha (liberação sem entrada correspondente)', async () => {
  const t = env.cX;
  const ok = (await run(t)).third;
  assert.equal(ok.status, 'OK');
  await entry(env, t, { nature: 'PAYABLE', amount: '100.00', third: true, release: 'RETURN', reference: 'Caução sem entrada', settled: dayAt(-1) });
  const { third } = await run(t);
  assert.equal(third.status, 'DEGRADED');
  assert.equal(third.value, null, 'saldo negativo de terceiros nunca vira número');
  const row = await e620.healthRow(env, t);
  assert.equal(row.third_party_cash, '-100.00');
});

test('m9d620 as conferências de qualidade do read model (reconciliação com o ledger e caixa livre + terceiros = caixa total) seguem passando com abertura e transferência', async () => {
  const t = env.cX;
  const acc = await account(env, t, { opening: '500.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '1000.00', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '300.00', third: true, reference: 'Caução contrato 3', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'ADJUSTMENT', type: 'DEBIT', amount: '200.00', key: `intercompany-transfer:${e620.ledger.uuid()}:from`, account: acc, settled: dayAt(-1) });
  await run(t);
  const out = await e620.inTx(t, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    const r = await refreshStore.startRefresh({ groupId: t.groupId, companyId: t.companyId, readModel: 'rm_finance_health', trigger: 'EVENT', version: 1 }, t, tx);
    const done = await refreshStore.finishRefresh(r.id, { status: 'SUCCEEDED', rowsUpserted: 1, sourceSnapshotAt: e620.NOW }, t, tx);
    return quality.checkRefresh({ readModel: 'rm_finance_health', scope: { companyId: t.companyId, groupId: t.groupId }, refreshId: done.id, rowsUpserted: 1, mode: 'EVENT' }, tx);
  });
  const status = (code) => out.results.find((r) => r.checkCode === code);
  assert.equal(status('finance_health_free_cash_reconciliation').status, 'PASSED', JSON.stringify(status('finance_health_free_cash_reconciliation')));
  assert.equal(status('finance_health_cash_split_consistency').status, 'PASSED', JSON.stringify(status('finance_health_cash_split_consistency')));
  assert.equal(status('finance_health_free_cash_reconciliation').expected.value, '2300.00', 'abertura 500 + 1.000 do primeiro teste + 1.000 - transferência 200');
});
