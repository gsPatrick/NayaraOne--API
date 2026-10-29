'use strict';

// M9-D620 — fin.free_cash e fin.third_party_cash: o número bate com o recalculado do zero só pelas linhas-fonte, a caução não vira caixa livre,
// o fuso de São Paulo decide o dia e os parâmetros do administrador mudam a conta. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e620 = require('../_helpers/m9d620Env');
const { cashFromSource } = require('../_helpers/m9d620Oracle');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs financeiros ao fim do refresh

const { entry, account, run, dayAt, readKpi, setSetting } = e620;
let env;
before(async () => { env = await e620.setup(); });
after(() => e620.teardown(env));

/** Cenário do exemplo da demanda: abertura 10.000, entradas próprias 100.000, de terceiros 35.000 (caução 8.000 e repasse 27.000), saídas próprias 20.000. */
async function exampleScenario(t) {
  const acc = await account(env, t, { opening: '10000.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100000.00', account: acc, settled: dayAt(-3) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '8000.00', third: true, reference: 'Caução contrato 12', account: acc, settled: dayAt(-2) });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '27000.00', third: true, reference: 'Repasse ao proprietário Maria — período 10/2026', account: acc, settled: dayAt(-1) });
  await entry(env, t, { nature: 'PAYABLE', amount: '20000.00', account: acc, center: e620.ledger.uuid(), settled: dayAt(-1) });
  // ruído que nunca entra: pendente, estornado, cancelado, o estorno e depois do fim do dia-base
  await entry(env, t, { nature: 'RECEIVABLE', amount: '999.00', status: 'PENDING', settled: null });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '777.00', status: 'REVERSED' });
  await entry(env, t, { nature: 'PAYABLE', amount: '555.00', status: 'CANCELLED' });
  await entry(env, t, { nature: 'PAYABLE', amount: '333.00', reversalOf: e620.ledger.uuid() });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '111.00', settled: '2026-10-29T03:00:00.000Z' });
  return acc;
}

test('m9d620 reproduz fin.free_cash a partir dos registros-fonte', async () => {
  const t = env.cX;
  await exampleScenario(t);
  const { free } = await run(t);
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(want.caixaTotal, '125000.00');
  assert.equal(want.freeCash, '90000.00');
  assert.equal(free.value, want.freeCash, 'o endpoint bate com o recalculado do zero, centavo a centavo');
  assert.deepEqual([free.unit, free.status, free.version], ['BRL', 'OK', 1]);
  const row = await e620.healthRow(env, t);
  assert.equal(row.total_cash, want.caixaTotal);
  assert.equal(row.free_cash, want.freeCash);
  assert.equal(row.opening_balance_total, '10000.00');
});

test('m9d620 reproduz fin.third_party_cash a partir dos registros-fonte', async () => {
  const t = env.cX;
  const { third } = await run(t);
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(want.terceirosRetidos, '35000.00');
  assert.equal(third.value, want.terceirosRetidos);
  assert.deepEqual([third.unit, third.status, third.version], ['BRL', 'OK', 1]);
  assert.equal((await readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:CAUCAO' })).value, '8000.00');
  assert.equal((await readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:REPASSE' })).value, '27000.00');
  assert.equal((await readKpi(t, 'fin.third_party_cash', { dimensionKey: 'origem:OUTRO' })).value, '0.00');
});

test('m9d620 freeCash exclui caução e fundos de terceiros', async () => {
  const t = env.cX;
  const before620 = await run(t);
  await entry(env, t, { nature: 'RECEIVABLE', amount: '5000.00', third: true, reference: 'Caução contrato 99', settled: dayAt(-1) });
  const after620 = await run(t);
  assert.equal(after620.free.value, before620.free.value, 'a caução de R$ 5.000,00 não muda o caixa livre');
  assert.equal(after620.third.value, '40000.00', 'o dinheiro de terceiros sobe os R$ 5.000,00');
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(want.caixaTotal, '130000.00', 'o caixa total sobe, o livre não');
  assert.equal(after620.free.value, want.freeCash);
  assert.equal((await e620.healthRow(env, t)).total_cash, '130000.00');
});

test('m9d620 devolução e compensação baixam o dinheiro de terceiros; a compensação (sem caixa) libera caixa livre', async () => {
  const t = env.cX;
  const before620 = await run(t);
  const origin = await entry(env, t, { nature: 'RECEIVABLE', amount: '1000.00', third: true, reference: 'Caução contrato 7', settled: dayAt(-1) });
  const debt = await entry(env, t, { nature: 'RECEIVABLE', amount: '300.00', settled: dayAt(0, 14), status: 'SETTLED' });
  await entry(env, t, { nature: 'PAYABLE', amount: '200.00', third: true, release: 'RETURN', origin, reference: 'Caução contrato 7', settled: dayAt(0, 13) });
  await entry(env, t, { nature: 'PAYABLE', amount: '300.00', third: true, release: 'COMPENSATION', origin, reference: 'Caução contrato 7', settled: dayAt(0, 14) });
  const after620 = await run(t);
  assert.equal(after620.third.value, '40500.00', 'recebeu 1.000, devolveu 200 e compensou 300: sobram 500');
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(after620.third.value, want.terceirosRetidos);
  assert.equal(after620.free.value, want.freeCash, 'devolução e compensação batem com o oracle');
  assert.notEqual(debt, origin);
  assert.equal(before620.third.value, '40000.00');
  assert.equal((await readKpi(env.cX, 'fin.third_party_cash', { dimensionKey: 'origem:CAUCAO' })).value, '13500.00', 'a liberação sai da origem da entrada (caução), não da referência da saída');
});

test('m9d620 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  await entry(env, t, { nature: 'RECEIVABLE', amount: '100.00', settled: '2026-10-29T02:30:00.000Z' }); // 23:30 de 28/10 em SP
  await entry(env, t, { nature: 'RECEIVABLE', amount: '40.00', settled: '2026-10-29T03:30:00.000Z' }); // 00:30 de 29/10 em SP: já é outro dia
  const { free } = await run(t);
  assert.equal(free.value, '100.00', 'só o das 23:30 de SP entra no dia 28/10');
  const want = await cashFromSource(env, t, e620.AS_OF);
  assert.equal(free.value, want.freeCash);
});

test('m9d620 caixa negativo é mostrado negativo, nunca truncado em zero', async () => {
  const t = env.cY;
  await entry(env, t, { nature: 'PAYABLE', amount: '250.00', settled: dayAt(-1) });
  const { free } = await run(t);
  assert.equal(free.value, '-150.00');
  assert.equal(free.status, 'OK');
});

test('m9d620 o parâmetro analytics.caixa.usar_saldo_abertura desliga a abertura e o KPI e o detalhe seguem juntos', async () => {
  const t = env.cX;
  const on = await run(t);
  await setSetting(env, t, 'analytics.caixa.usar_saldo_abertura', false);
  const off = await run(t);
  assert.equal(Number(on.free.value) - Number(off.free.value), 10000, 'a abertura de 10.000,00 sai do caixa livre');
  const want = await cashFromSource(env, t, e620.AS_OF, { includeOpening: false });
  assert.equal(off.free.value, want.freeCash);
  assert.equal((await e620.healthRow(env, t)).opening_balance_total, '10000.00', 'o read model guarda a abertura; só o cálculo do caixa a ignora');
  await setSetting(env, t, 'analytics.caixa.usar_saldo_abertura', true);
  assert.equal((await run(t)).free.value, on.free.value);
});

test('m9d620 transferência entre empresas liquidada sai de uma conta e entra em outra: cada empresa vê a sua perna', async () => {
  const [from, to] = [env.cX, env.cY];
  const [beforeFrom, beforeTo] = [await run(from), await run(to)];
  const id = e620.ledger.uuid();
  await entry(env, from, { nature: 'ADJUSTMENT', type: 'DEBIT', amount: '10000.00', key: `intercompany-transfer:${id}:from`, settled: dayAt(-1) });
  await entry(env, to, { nature: 'ADJUSTMENT', type: 'CREDIT', amount: '10000.00', key: `intercompany-transfer:${id}:to`, settled: dayAt(-1) });
  const [afterFrom, afterTo] = [await run(from), await run(to)];
  assert.equal(Number(afterFrom.free.value) - Number(beforeFrom.free.value), -10000);
  assert.equal(Number(afterTo.free.value) - Number(beforeTo.free.value), 10000);
  assert.equal(afterFrom.free.value, (await cashFromSource(env, from, e620.AS_OF)).freeCash);
  assert.equal(afterTo.free.value, (await cashFromSource(env, to, e620.AS_OF)).freeCash);
});
