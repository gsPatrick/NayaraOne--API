'use strict';

// M9-D710 (3.2) — a janela dos fatos do dia: hoje termina no instante da leitura (móvel), data passada termina às 00:00 do dia seguinte de São Paulo (exclusivo), a anterior tem a mesma
// duração e a duração vem do parâmetro analytics.centro.janela_horas. Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d710Env');
const sc = require('../_helpers/m9d710Scenario');
const oracle = require('../_helpers/m9d710Oracle');
const { windowOf } = require('../../../src/features/analytics/metrics/kpis/centro-comando/windows');

const NOW = new Date('2026-10-28T15:00:00Z');
const iso = (d) => d.toISOString();
let env;
before(async () => {
  env = await kit.setup();
  const t = env.cX;
  for (const [when, amount] of [
    ['2026-10-27T14:59:59.999Z', '11000.00'], // um milissegundo antes da janela de hoje (cai na anterior)
    ['2026-10-27T15:00:00.000Z', '12000.00'], // início da janela de hoje (inclusivo)
    ['2026-10-28T02:59:59.000Z', '20000.00'], // 27/10 23:59:59 em São Paulo
    ['2026-10-28T03:00:00.000Z', '21000.00'], // 28/10 00:00:00 em São Paulo
    ['2026-10-28T15:00:00.000Z', '22000.00'], // exatamente agora (inclusivo)
    ['2026-10-28T15:00:00.002Z', '23000.00'], // depois de agora: não entra
  ]) await sc.payment(env, t, { amount, settledAt: when, account: sc.ACCOUNT_A });
  await kit.rebuild(t);
});
after(() => kit.teardown(env));

const payments = async (asOf = kit.AS_OF) => (await kit.kpis(env.cX, asOf)).cmd.kpis['fin.payments_settled_relevant'];

test('m9d710 janela móvel de hoje e janela de data passada terminam no instante certo', async () => {
  const today = windowOf('2026-10-28', NOW, 24);
  assert.deepEqual([iso(today.from), iso(today.to), iso(today.previousFrom), today.isToday], ['2026-10-27T15:00:00.000Z', '2026-10-28T15:00:00.001Z', '2026-10-26T15:00:00.000Z', true], 'hoje: termina no instante da leitura');
  const past = windowOf('2026-10-27', NOW, 24);
  assert.deepEqual([iso(past.from), iso(past.to), iso(past.previousFrom), past.isToday], ['2026-10-27T03:00:00.000Z', '2026-10-28T03:00:00.000Z', '2026-10-26T03:00:00.000Z', false], 'passado: termina 00:00 do dia seguinte de São Paulo');
  const long = windowOf('2026-10-27', NOW, 48);
  assert.deepEqual([iso(long.from), iso(long.previousFrom)], ['2026-10-26T03:00:00.000Z', '2026-10-24T03:00:00.000Z'], 'a anterior tem a mesma duração (48 h)');
  const r = await payments();
  const want = await oracle.paymentsFromSource(env, env.cX, oracle.windowEndingAt(NOW, 24));
  assert.deepEqual([r.value, r.details.amount], [String(want.count), want.amount]);
  assert.deepEqual([r.value, r.details.amount], ['4', '75000.00'], 'hoje: 12.000 (início), 20.000, 21.000 e 22.000 (agora); 23.000 é futuro e 11.000 é da janela anterior');
  assert.deepEqual([r.details.previous.count, r.details.previous.amount], ['1', '11000.00']);
});

test('m9d710 a data passada termina à meia-noite de São Paulo (exclusivo) e a anterior tem a mesma duração', async () => {
  const r = await payments('2026-10-27');
  const want = await oracle.paymentsFromSource(env, env.cX, oracle.windowOfPastDay('2026-10-27', 24));
  assert.deepEqual([r.value, r.details.amount], [String(want.count), want.amount]);
  assert.deepEqual([r.value, r.details.amount], ['3', '43000.00'], '27/10: 11.000 (11:59), 12.000 (12:00) e 20.000 (23:59:59); o de 00:00:00 do dia 28 não entra');
  assert.deepEqual([r.details.previous.count, r.details.previous.amount], ['0', '0.00']);
});

test('m9d710 a duração da janela vem de analytics.centro.janela_horas', async () => {
  await kit.setSetting(env, env.cX, 'analytics.centro.janela_horas', 6);
  const six = await payments();
  assert.deepEqual([six.value, six.details.amount], ['1', '22000.00'], 'seis horas até agora: só o das 12:00 em ponto (os de 00:00 e antes ficam de fora)');
  await kit.setSetting(env, env.cX, 'analytics.centro.janela_horas', 48);
  const wide = await payments();
  const want = await oracle.paymentsFromSource(env, env.cX, oracle.windowEndingAt(NOW, 48));
  assert.deepEqual([wide.value, wide.details.amount], [String(want.count), want.amount]);
  assert.equal(wide.value, '5', '48 h: entra também o de 11.000,00 (a janela agora começa em 26/10 12:00)');
  await kit.setSetting(env, env.cX, 'analytics.centro.janela_horas', 24);
});
