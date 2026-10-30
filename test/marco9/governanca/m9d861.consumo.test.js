'use strict';

// M9-D861 — consumo do mês: série ESTIMATED no mês aberto, BILLED no fechado, sempre lado a lado e sem total misto (banco descartável).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d861Env');
const { consumptionOf, percentOf } = require('../../../src/features/core-governance/finops/budgets/budget.consumption');
const { monthKeyOf } = require('../../../src/features/core-governance/finops/budgets/budget.period');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d861 percentual é o piso de 100 x consumo / orçamento, em inteiros', () => {
  assert.equal(percentOf(150000, 300000), 50);
  assert.equal(percentOf(299999, 300000), 99);
  assert.equal(percentOf(330000, 300000), 110);
  assert.equal(percentOf(0, 300000), 0);
  assert.equal(percentOf(-500, 300000), 0, 'crédito acima do gasto não dá percentual negativo');
  assert.equal(percentOf(9007199254740991, 1), 900719925474099100, 'sem ponto flutuante');
});

test('m9d861 consumo mostra faturado e estimado separados', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.spend(A, tx, 100000, { category: 'STORAGE', service: 'arquivos' });
    await env.spend(A, tx, 60000, { category: 'AI', service: 'llm:x' });
    await env.spend(A, tx, 7000, { costKind: 'BILLED', category: 'PROVIDER', service: 'fatura-parcial' });
    const [view] = await env.budgets.listBudgets(A, tx);
    assert.equal(view.id, budget.id);
    assert.deepEqual(view.consumo, { estimado: { totalCentavos: 160000 }, faturado: { totalCentavos: 7000 }, serieBase: 'ESTIMATED', consumidoCentavos: 160000 });
    assert.equal(view.percentual, 53);
    assert.equal(JSON.stringify(view).match(/total(?!Centavos)/i), null, 'nenhum campo de total misto');
  });
});

test('m9d861 percentual usa só a série ESTIMATED no mês aberto e BILLED no fechado, sem total misto', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    // mês aberto: ESTIMATED R$ 1.600,00 (storage 1.000 + IA 600) = 53%, alerta 50
    await env.spend(A, tx, 100000, { category: 'STORAGE', service: 'arquivos' });
    await env.spend(A, tx, 60000, { category: 'AI', service: 'llm:x' });
    assert.deepEqual((await env.alertsOf(budget.id, tx)).map((a) => [a.threshold, a.percent, a.series]), [[50, 53, 'ESTIMATED']]);
    // mês fechado (mês anterior): estimado 2.400 (80%) dispara 50 e 75; a fatura de 3.300 vira a base FINAL (110%) sem disparar 90 nem 100
    await env.spend(A, tx, 240000, { day: env.PREV_MONTH_DAY, service: 'cloud-mes' });
    const prev = monthKeyOf(new Date(`${env.PREV_MONTH_DAY}T12:00:00Z`));
    const row = await env.budgets.listBudgets(A, tx);
    assert.equal(row[0].mes.chave, monthKeyOf(new Date()), 'a visão corrente é do mês corrente');
    const before = (await env.alertsOf(budget.id, tx)).filter((a) => a.period_start === `${prev}-01`);
    assert.deepEqual(before.map((a) => a.threshold), [50, 75]);
    const [y, m] = prev.split('-').map(Number);
    const start = env.midnightSp(`${prev}-01`);
    const end = env.midnightSp(`${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}`);
    await env.record(A, [env.dayLine(A, `${prev}-01`, { costKind: 'BILLED', service: 'cloud-mes', amountCents: 330000, periodStart: start, periodEnd: end, sourceRef: env.uniq() })], tx);
    const c = await consumptionOf(A, { environment: 'PROD', domain: 'PLATFORM', amount_cents: 300000 }, prev, new Date(), tx);
    assert.deepEqual([c.baseSeries, c.final, c.consumedCents, c.percent, c.billedCents], ['BILLED', true, 330000, 110, 330000]);
    assert.equal(c.estimatedCents, 0, 'o estimado substituído pela fatura deixa de contar, sem somar com ela');
    const after = (await env.alertsOf(budget.id, tx)).filter((a) => a.period_start === `${prev}-01`);
    assert.deepEqual(after.map((a) => a.threshold), [50, 75], 'o percentual final não dispara 90 nem 100');
  });
});
