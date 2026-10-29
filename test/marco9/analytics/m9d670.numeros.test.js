'use strict';

// M9-D670 — os quatro KPIs de Marketing (campanhas, custo, leads, atribuição) recalculados do zero SÓ com as linhas-fonte (oráculo: consultas diretas ao OLTP) e
// comparados com o que o BI calcula pelos read models; e cada regra de qualidade violada deixa DEGRADED/INCOMPLETE, sem valor. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d670Scenario');
const oracle = require('../_helpers/m9d670Oracle');

const MONTH = '2026-10';
let env;
let good;
let bad;
before(async () => {
  env = await kit.setup();
  env.ids = await sc.bom(env, env.cX);
  env.bad = await sc.ruim(env, env.cY);
  await kit.refreshAll(env, env.cX);
  await kit.refreshAll(env, env.cY);
  good = (await kit.kpis(env.cX)).kpis;
  bad = (await kit.kpis(env.cY)).kpis;
});
after(() => kit.teardown(env));

const dims = (r) => Object.fromEntries(r.dimensions.map((d) => [d.key, d.value]));
const noValue = (r, statuses) => {
  assert.ok(statuses.includes(r.status), `status ${r.status}`);
  assert.equal(r.value, null);
  assert.equal(r.message, 'Dado incompleto, valor não confiável.');
};

test('m9d670 reproduz mkt.campaigns a partir dos registros-fonte', async () => {
  const want = await oracle.campaignsFromSource(env, env.cX, MONTH);
  const r = good['mkt.campaigns'];
  assert.equal(r.status, 'OK');
  assert.equal(Number(r.value), want.active);
  assert.equal(Number(dims(r).encerradas_qtd), want.ended);
  assert.deepEqual([want.active, want.ended], [2, 1], 'cenário: C1 e C2 em andamento, C3 encerrada em outubro (C4 em setembro e C5 rascunho ficam de fora)');
  for (const [channel, v] of Object.entries(want.byChannel)) {
    assert.equal(Number(dims(r)[`canal:${channel}:ativas_qtd`]), v.active, channel);
    assert.equal(Number(dims(r)[`canal:${channel}:encerradas_qtd`]), v.ended, channel);
  }
  assert.equal(Number(await kit.dimension(env.cX, 'mkt.campaigns', 'encerradas_qtd')), want.ended, 'o snapshot gravado traz a mesma dimensão');
});

test('m9d670 mkt.campaigns fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  noValue(bad['mkt.campaigns'], ['DEGRADED', 'INCOMPLETE']);
  assert.equal(bad['mkt.campaigns'].details.reason, 'CAMPANHA_SEM_CANAL');
  assert.equal((await oracle.campaignsFromSource(env, env.cY, MONTH)).noChannel, 1);
});

test('m9d670 reproduz mkt.cost a partir dos registros-fonte', async () => {
  const want = await oracle.costFromSource(env, env.cX, MONTH);
  const r = good['mkt.cost'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, oracle.money(want.settled));
  assert.equal(r.details.planned, oracle.money(want.planned));
  assert.equal(r.value, '3350.25', 'C1 2.000,10 + 1.199,90 (23:30 de 31/10) + C2 100,00 + C3 50,25; novembro, setembro, terceiros e sem ligação ficam de fora');
  assert.equal(r.details.planned, '500.00');
  for (const [id, v] of Object.entries(want.byCampaign)) if (v.settled) assert.equal(dims(r)[`campanha:${id}:custo_brl`], oracle.money(v.settled), id);
  assert.equal(Number(await kit.dimension(env.cX, 'mkt.cost', `campanha:${env.ids.c1}:custo_brl`)), 3200, 'o snapshot gravado traz a mesma dimensão');
});

test('m9d670 mkt.cost fica DEGRADED com valor nulo quando a regra de qualidade falha', () => {
  noValue(bad['mkt.cost'], ['DEGRADED', 'INCOMPLETE']);
  assert.equal(bad['mkt.cost'].status, 'INCOMPLETE');
  assert.equal(bad['mkt.cost'].details.reason, 'CAMPANHA_SEM_CENTRO_DE_CUSTO');
  assert.deepEqual([...bad['mkt.cost'].details.withoutCostCenter].sort(), [env.bad.semCanal, env.bad.semCusto].sort());
});

test('m9d670 reproduz mkt.leads a partir dos registros-fonte', async () => {
  const want = await oracle.leadsFromSource(env, env.cX, MONTH);
  const r = good['mkt.leads'];
  assert.equal(r.status, 'OK');
  assert.equal(Number(r.value), want.total);
  assert.equal(Number(dims(r).sem_campanha_qtd), want.none);
  assert.deepEqual([want.total, want.none], [8, 1], '5 de C1, 2 de C2 e 1 sem campanha; setembro e lead sem origem de marketing ficam de fora');
  for (const [id, v] of Object.entries(want.byCampaign)) if (v.leads) assert.equal(Number(dims(r)[`campanha:${id}:leads_qtd`]), v.leads, id);
  assert.equal(r.details.withoutCampaignPct, '12.50');
});

test('m9d670 mkt.leads fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const want = await oracle.leadsFromSource(env, env.cY, MONTH);
  assert.deepEqual([want.total, want.none], [10, 4]);
  noValue(bad['mkt.leads'], ['DEGRADED', 'INCOMPLETE']);
  assert.equal(bad['mkt.leads'].status, 'DEGRADED');
  assert.equal(bad['mkt.leads'].details.withoutCampaignPct, '40.00');
});

test('m9d670 reproduz mkt.attribution a partir dos registros-fonte', async () => {
  const leads = await oracle.leadsFromSource(env, env.cX, MONTH);
  const cost = await oracle.costFromSource(env, env.cX, MONTH);
  const withLink = Object.keys(leads.byCampaign).filter((id) => id !== env.ids.c5);
  const last = withLink.reduce((n, id) => n + leads.byCampaign[id].last, 0);
  const sales = withLink.reduce((n, id) => n + leads.byCampaign[id].sales, 0);
  const first = withLink.reduce((n, id) => n + leads.byCampaign[id].first, 0);
  const r = good['mkt.attribution'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, oracle.money(Math.round(cost.settled / last)), 'custo por lead = custo ÷ leads atribuídos (2 casas, uma só vez)');
  assert.deepEqual([last, sales, first, leads.outside], [6, 2, 1, 1]);
  const d = dims(r);
  assert.deepEqual([d.leads_atribuidos_qtd, d.vendas_atribuidas_qtd, d['first:leads_atribuidos_qtd'], d.fora_da_janela_qtd], ['6', '2', '1', '1']);
  assert.equal(d.custo_por_venda_brl, oracle.money(Math.round(cost.settled / sales)));
  assert.equal(d[`campanha:${env.ids.c1}:custo_por_lead_brl`], oracle.money(Math.round(cost.byCampaign[env.ids.c1].settled / leads.byCampaign[env.ids.c1].last)));
  assert.equal(r.details.outsideWindow, '1', 'a venda sem toque válido na janela fica fora do cálculo e contada');
  assert.deepEqual(r.details.withoutCostCenter, [env.ids.c5]);
});

test('m9d670 mkt.attribution fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  noValue(bad['mkt.attribution'], ['DEGRADED', 'INCOMPLETE']);
  assert.equal(bad['mkt.attribution'].status, 'INCOMPLETE', 'nenhuma campanha com custo conhecido tem lead atribuído');
  // o limite de atribuição fora da janela é do administrador: 33% das vendas fora da janela com limite de 20% derruba o valor
  await kit.setSetting(env, env.cX, 'analytics.qualidade.max_fora_janela_pct', 20);
  const limited = (await kit.kpis(env.cX)).kpis['mkt.attribution'];
  noValue(limited, ['DEGRADED']);
  assert.equal(limited.details.reason, 'ATRIBUICAO_FORA_DA_JANELA_ACIMA_DO_LIMITE');
  await kit.setSetting(env, env.cX, 'analytics.qualidade.max_fora_janela_pct', 100);
  assert.equal((await kit.kpis(env.cX)).kpis['mkt.attribution'].status, 'OK', 'padrão do livro: só conta em details.outsideWindow');
});

test('m9d670 o limite de leads sem campanha e o owner são parâmetros lidos do administrador', async () => {
  await kit.setSetting(env, env.cY, 'analytics.qualidade.max_sem_campanha_pct', 40);
  assert.equal((await kit.kpis(env.cY)).kpis['mkt.leads'].status, 'OK', '40% sem campanha com limite de 40%: mantém o valor');
  await kit.setSetting(env, env.cY, 'analytics.qualidade.max_sem_campanha_pct', 20);
  assert.equal((await kit.kpis(env.cY)).kpis['mkt.leads'].status, 'DEGRADED');
});
