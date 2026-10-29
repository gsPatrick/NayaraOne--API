'use strict';

// M9-D653 (correção da reabertura) — a janela das perdas de estoque é parâmetro do administrador (analytics.estoque.janela_perdas_dias, padrão 30):
// trocar a janela muda o valor do KPI inv.losses e o detalhe continua reconciliando; valor fora da faixa é recusado e cai no padrão.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d653Scenario');
const oracle = require('../_helpers/m9d653Oracle');
const refs = require('../_helpers/m9d652Refs');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { readLossWindowDays } = require('../../../src/features/analytics/read-models/obra.settings');

const KEY = 'analytics.estoque.janela_perdas_dias';
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
let env;
const T = () => env.cX;
before(async () => {
  env = await e.setup();
  const stock = await sc.seedStock(env, T());
  await sc.seedLosses(env, T(), stock.a); // perdas decididas em 20/10 (1.800,00), 10/10 (650,00) e 28/09 (700,00); 28/10 é a data-base
  await sc.refresh(T());
});
after(() => e.teardown(env));

const losses = async () => { await sc.refresh(T()); const out = await e.run(T(), 'inv'); return out.kpis['inv.losses']; };

test('m9d653 a janela das perdas é parâmetro do administrador, declarado no SETTINGS_SCHEMA com padrão 30 e faixa de 1 a 365', async () => {
  assert.ok(SETTINGS_SCHEMA[KEY], 'declarado no SETTINGS_SCHEMA');
  assert.deepEqual([SETTINGS_SCHEMA[KEY].type, SETTINGS_SCHEMA[KEY].min, SETTINGS_SCHEMA[KEY].max], ['integer', 1, 365]);
  assert.equal(await e.inTx(T(), {}, (tx) => readLossWindowDays({ companyId: T().companyId, groupId: T().groupId }, tx)), 30);
});

test('m9d653 janela padrão de 30 dias: 2.450,00 e o read model guarda a janela usada', async () => {
  same((await losses()).value, '2450.00', 'padrão');
  const [row] = await e.rowsOf(env, 'rm_inventory_health', T());
  assert.equal(Number(row.losses_window_days), 30);
});

test('m9d653 trocar a janela muda o valor de inv.losses e o detalhe continua reconciliando', async () => {
  for (const [days, want] of [[10, '1800.00'], [40, '3150.00'], [5, '0.00']]) {
    await e.setSetting(env, T(), KEY, days);
    const kpi = await losses();
    same(kpi.value, want, `janela de ${days} dias`);
    same((await oracle.losses(env, T(), e.AS_OF, days)).total, want, `a fonte, na mão, para ${days} dias`);
    assert.equal(Number((await e.rowsOf(env, 'rm_inventory_health', T()))[0].losses_window_days), days);
    same((await e.readKpi(T(), 'inv.losses')).value, want, 'o snapshot lido traz o mesmo valor');
    if (days === 5) continue;
    const d = await refs.drill(env, T(), 'inv.losses', ['inventory:read']);
    same(d.sum, want, `linhas + ajuste do detalhe = valor do KPI (${days} dias)`);
  }
});

test('m9d653 valor inválido do parâmetro cai no padrão de 30 dias', async () => {
  for (const bad of [0, -3, 'abc', 4000]) {
    await e.setSetting(env, T(), KEY, bad);
    assert.equal(await e.inTx(T(), {}, (tx) => readLossWindowDays({ companyId: T().companyId, groupId: T().groupId }, tx)), 30, String(bad));
  }
  same((await losses()).value, '2450.00', 'valor corrompido não muda o cálculo');
});
