'use strict';

// M9-D625 — consolidado do grupo por GET /analytics/metrics/:code?groupId=: soma por leitura, eliminação dos dois lados do intercompany, par sem
// contrapartida (DEGRADED, sem eliminar por aproximação), taxa por numerador e denominador e a reprodução (byCompany - eliminations = value).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e625 = require('../_helpers/m9d625Env');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const { CODES } = e625;
let env;
const body = (res) => res.body.data;
const sumOf = (d) => money.money(money.toString(money.sum(d.byCompany.map((c) => c.value))));
const reproduces = (d) => assert.equal(money.money(d.value), money.money(money.toString(money.sub(sumOf(d), d.eliminations))), 'soma de byCompany menos eliminations iguala o consolidado');

before(async () => {
  env = await e625.setup();
  // Imobiliária (X) paga 10.000,00 à Construtora (Y), liquidado nos dois lados; a receita da Construtora e o custo da Imobiliária já contêm a transferência
  await e625.snapshot(env, env.cX, CODES.revenue, '80000.00');
  await e625.snapshot(env, env.cY, CODES.revenue, '50000.00');
  await e625.snapshot(env, env.cX, CODES.cost, '40000.00');
  await e625.snapshot(env, env.cY, CODES.cost, '30000.00');
  await e625.transfer(env, env.cX, env.cY);
  await e625.refreshPairs(env.cX);
});
after(() => e625.teardown(env));

test('m9d625 consolidado soma intercompany duas vezes é corrigido pela eliminação na leitura', async () => {
  const res = await e625.get(env, CODES.revenue);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = body(res);
  assert.equal(sumOf(d), '130000.00', 'somar sem eliminar daria 130.000,00 (erro)');
  assert.equal(d.eliminations, '10000.00');
  assert.equal(money.money(d.value), '120000.00');
  assert.equal(d.consolidatedStatus, 'OK');
  assert.deepEqual(d.byCompany.map((c) => c.value).sort(), ['50000.00', '80000.00'], 'a abertura por empresa aparece');
  assert.deepEqual(d.details.unmatchedIntercompany, []);
  reproduces(d);
});

test('m9d625 intercompany não duplica o consolidado (receita e custo)', async () => {
  const revenue = body(await e625.get(env, CODES.revenue));
  const cost = body(await e625.get(env, CODES.cost));
  assert.equal(money.money(revenue.value), '120000.00', 'receita 80.000 + 50.000 - 10.000');
  assert.equal(money.money(cost.value), '60000.00', 'custo 40.000 + 30.000 - 10.000');
  assert.equal(revenue.eliminations, cost.eliminations, 'os dois lados saem do mesmo valor');
  reproduces(revenue);
  reproduces(cost);
});

test('m9d625 taxa consolidada usa numerador e denominador somados', async () => {
  // inadimplência: X 8% de base 200.000 (16.000) e Y 2% de base 100.000 (2.000) => (16.000 + 2.000) / 300.000 = 6,00% (e não a média, 5,00%)
  await e625.snapshot(env, env.cX, CODES.rate, '8.00');
  await e625.snapshot(env, env.cX, CODES.rate, '16000.00', { dimensionKey: 'numerador' });
  await e625.snapshot(env, env.cX, CODES.rate, '200000.00', { dimensionKey: 'denominador' });
  await e625.snapshot(env, env.cY, CODES.rate, '2.00');
  await e625.snapshot(env, env.cY, CODES.rate, '2000.00', { dimensionKey: 'numerador' });
  await e625.snapshot(env, env.cY, CODES.rate, '100000.00', { dimensionKey: 'denominador' });
  const d = body(await e625.get(env, CODES.rate));
  assert.equal(money.money(d.value), '6.00');
  assert.notEqual(money.money(d.value), '5.00', 'nunca a média das taxas');
  assert.deepEqual([d.details.numerator, d.details.denominator, d.eliminations], ['18000.00', '300000.00', '0.00']);
  assert.deepEqual(d.byCompany.map((c) => money.money(c.value)).sort(), ['2.00', '8.00']);
});

test('m9d625 par sem contrapartida deixa DEGRADED sem eliminar por aproximação', async () => {
  const lone = await e625.transfer(env, env.cX, env.cY, { amount: '4000.00', toStatus: 'CANCELLED' }); // só a saída existe
  const mismatch = await e625.transfer(env, env.cX, env.cY, { amount: '3000.00', toAmount: '2999.00' }); // valores diferentes
  await e625.refreshPairs(env.cX);
  const res = await e625.get(env, CODES.revenue);
  assert.equal(res.status, 200);
  const d = body(res);
  assert.equal(d.consolidatedStatus, 'DEGRADED');
  assert.equal(d.code, 'ANALYTICS_INTERCOMPANY_UNMATCHED');
  assert.equal(d.message, 'Há transferências entre empresas sem contrapartida; o consolidado está incompleto.');
  assert.equal(d.eliminations, '10000.00', 'só o par inteiro foi eliminado; nenhum valor aproximado dos pares incompletos');
  const listed = d.details.unmatchedIntercompany;
  assert.deepEqual(listed.filter((u) => u.transferId === lone.id), [{ transferId: lone.id, lado: 'SAIDA', valor: '4000.00' }]);
  assert.deepEqual(listed.filter((u) => u.transferId === mismatch.id).map((u) => [u.lado, u.valor]).sort(), [['ENTRADA', '2999.00'], ['SAIDA', '3000.00']]);
  assert.equal(listed.length, 3);
  reproduces(d);
});

test('m9d625 a transferência só entra no mesmo período e só quando liquidada nos dois lados', async () => {
  const pending = await e625.transfer(env, env.cX, env.cY, { amount: '777.00', toStatus: 'PENDING' });
  const outside = await e625.transfer(env, env.cX, env.cY, { amount: '888.00', settled: '2026-09-15T15:00:00.000Z' });
  await e625.refreshPairs(env.cX);
  const d = body(await e625.get(env, CODES.revenue));
  assert.equal(d.eliminations, '10000.00', 'pendente num dos lados e liquidada fora do período do registro não são eliminadas');
  assert.ok(pending.id && outside.id);
  assert.equal(d.eliminatedTransfers, 1);
});
