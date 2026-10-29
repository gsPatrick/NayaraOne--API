'use strict';

// M9-D631 — crm.opportunities_by_stage e crm.conversion_rate: o número do KPI refeito do zero só com as oportunidades da fonte, a regra de qualidade
// (sem estágio, amostra curta), o fuso de São Paulo e os parâmetros do administrador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/crmKpiEnv');
const { stagesFromSource, outcomesFromSource } = require('../_helpers/crmOracle631');

const { src, at, opp, TODAY } = kit;
let env;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

const dim = (t, code, key, asOfDate = TODAY) => kit.dimension(t, code, key, asOfDate);

test('m9d631 reproduz crm.opportunities_by_stage a partir dos registros-fonte', async () => {
  const t = env.cX;
  const [b1, b2] = [src.uuid(), src.uuid()];
  const ids = [];
  const closed = {};
  const add = async (c, outcome) => { const id = await opp(env, t, c); ids.push(id); if (outcome) closed[id] = outcome; return id; };
  // em aberto: 3 NEW (parados há 0, 2 e 8 dias), 2 VISIT_SCHEDULED (um com mensagem recente)
  await add({ owner: b1, stage: 'NEW', created: at(1), updated: at(28) });
  await add({ owner: b1, stage: 'NEW', created: at(1), updated: at(26) });
  await add({ owner: b2, stage: 'NEW', created: at(1), updated: at(20) });
  const visit = await add({ owner: b2, stage: 'VISIT_SCHEDULED', created: at(1), updated: at(10) });
  await src.message(env, t, { opportunity: visit, direction: 'INBOUND', author: 'CLIENT', created: at(27) }); // mensagem recente tira a oportunidade da lista de paradas
  await add({ owner: b1, stage: 'VISIT_SCHEDULED', created: at(1), updated: at(14) });
  // fechadas em outubro (entram), em setembro (fora) e excluída (fora)
  await add({ owner: b1, stage: 'CLOSED_WON', created: at(1), closedAt: at(10) }, 'won');
  await add({ owner: b2, stage: 'CLOSED_WON', created: at(1), closedAt: at(12) }, 'won');
  await add({ owner: b2, stage: 'CLOSED_LOST', created: at(1), closedAt: at(13), lostReason: 'PRICE' }, 'lost');
  await add({ owner: b1, stage: 'WITHDRAWN', created: at(1), closedAt: at(14) }, 'lost');
  await add({ owner: b1, stage: 'CLOSED_WON', created: '2026-08-01T15:00:00Z', closedAt: '2026-09-15T15:00:00Z' }, 'won');
  const gone = await opp(env, t, { owner: b1, stage: 'NEW', created: at(1), updated: at(28) });
  await src.update(env, 'crm.opportunities', gone, { deleted_at: at(28) });
  await kit.refreshAll(t, ids, closed);
  await kit.kpis(t);

  const want = await stagesFromSource(env, t, TODAY);
  assert.deepEqual(want.counts, { NEW: 3, VISIT_SCHEDULED: 2, CLOSED_WON: 2, CLOSED_LOST: 1, WITHDRAWN: 1 });
  const kpi = await kit.readKpi(t, 'crm.opportunities_by_stage');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'crm.opportunities_by_stage']);
  assert.equal(Number(kpi.value), Number(want.total), 'total igual ao da fonte (em aberto mais fechadas no mês)');
  for (const [stage, count] of Object.entries(want.counts)) assert.equal(Number(await dim(t, 'crm.opportunities_by_stage', `estagio:${stage}`)), count, `contagem de ${stage}`);
  for (const [stage, avg] of Object.entries(want.avgIdle)) assert.equal(Number(await dim(t, 'crm.opportunities_by_stage', `estagio:${stage}:media_dias`)), Number(avg), `dias parados em ${stage}`);
  assert.equal(want.avgIdle.NEW, '3.3', '(0 + 2 + 8) / 3');
  assert.equal(Number(await dim(t, 'crm.opportunities_by_stage', `corretor:${b1}`)), 5);
  assert.equal(kpi.sourceRefs[0].count, Number(want.total), 'o detalhe abre exatamente as oportunidades contadas');
});

test('m9d631 crm.opportunities_by_stage fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cY;
  const ids = [await opp(env, t, { owner: src.uuid(), stage: 'NEW', created: at(2), updated: at(28) }), await opp(env, t, { owner: src.uuid(), stage: '', created: at(2), updated: at(28) })];
  await kit.refreshAll(t, ids);
  await kit.kpis(t);
  const kpi = await kit.readKpi(t, 'crm.opportunities_by_stage');
  assert.equal(kpi.status, 'DEGRADED', 'oportunidade sem estágio');
  assert.equal(kpi.value, null, 'nunca um número enganoso');
});

test('m9d631 reproduz crm.conversion_rate a partir dos registros-fonte', async () => { // exemplo da demanda: 6 ganhas e 14 perdidas => 30,00%
  const t = env.cX;
  const { ids, closed, brokers } = await kit.augustOutcomes(env, t);
  await kit.refreshAll(t, ids, closed);
  await kit.kpis(t, '2026-08-31');
  const want = await outcomesFromSource(env, t, '2026-08-31');
  assert.deepEqual([want.won, want.lost, want.conversion], [6, 14, '30.00'], 'a desistência não entra nem como ganha nem como perdida');
  const kpi = await kit.readKpi(t, 'crm.conversion_rate', { asOfDate: '2026-08-31' });
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'PERCENT', 1]);
  assert.equal(Number(kpi.value), Number(want.conversion), 'a taxa do KPI é a da fonte, 2 casas');
  assert.equal(Number(await dim(t, 'crm.conversion_rate', 'ganhas_qtd', '2026-08-31')), 6);
  assert.equal(Number(await dim(t, 'crm.conversion_rate', 'perdidas_qtd', '2026-08-31')), 14);
  assert.equal(Number(await dim(t, 'crm.conversion_rate', `corretor:${brokers[0]}:taxa_pct`, '2026-08-31')), 30, '3 ganhas em 10 fechadas do corretor');
  await kit.inTx(t, {}, async (tx) => {
    const { sourceRefs: [ref] } = await kit.registry.buildSourceRefs(kit.ctxOf(t), 'crm.conversion_rate', { filter: kpi.sourceRefs[0].filter, unit: 'PERCENT' }, tx);
    assert.equal(ref.count, 20, 'o detalhe abre as 20 oportunidades ganhas e perdidas do mês');
    const r = await kit.registry.reconcileDetail(kit.ctxOf(t), 'crm.conversion_rate', ref, kpi.value, { unit: 'PERCENT' }, tx);
    assert.equal(r.ok, true, `a fórmula refeita sobre as linhas-fonte dá ${r.detail}; o KPI ${r.kpi}`);
  });
});

test('m9d631 crm.conversion_rate fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => { // amostra curta: INCOMPLETE; o mínimo é parâmetro
  const t = env.cY;
  const ids = [];
  const closed = {};
  for (let i = 0; i < 4; i += 1) { const id = await opp(env, t, { owner: src.uuid(), stage: i === 0 ? 'CLOSED_WON' : 'CLOSED_LOST', created: at(1), closedAt: at(5 + i), lostReason: 'PRICE' }); ids.push(id); closed[id] = i === 0 ? 'won' : 'lost'; }
  await kit.refreshAll(t, ids, closed);
  await kit.kpis(t);
  let kpi = await kit.readKpi(t, 'crm.conversion_rate');
  assert.equal(kpi.status, 'INCOMPLETE', '4 fechadas < mínimo de 5');
  assert.equal(kpi.value, null);
  await kit.setSetting(env, t, 'analytics.qualidade.min_amostra', 4);
  await kit.kpis(t);
  kpi = await kit.readKpi(t, 'crm.conversion_rate');
  assert.equal(kpi.status, 'OK');
  assert.equal(Number(kpi.value), 25, '1 ganha em 4 fechadas');
});

test('m9d631 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => { // fechamento às 23:30 do dia 31 é de outubro, não de novembro
  const t = env.cY;
  const ids = [];
  const closed = {};
  const edge = async (stage, closedAt) => { const id = await opp(env, t, { owner: src.uuid(), stage, created: '2026-08-01T15:00:00Z', closedAt, lostReason: 'PRICE' }); ids.push(id); closed[id] = stage === 'CLOSED_WON' ? 'won' : 'lost'; };
  await edge('CLOSED_LOST', '2026-11-01T02:30:00Z'); // 23:30 de 31/10 em SP: ainda outubro (em UTC já é novembro)
  await edge('CLOSED_WON', '2026-10-01T02:30:00Z'); // 23:30 de 30/09 em SP: setembro (em UTC já é outubro)
  await kit.refreshAll(t, ids, closed);
  const want = await outcomesFromSource(env, t, '2026-10-31');
  assert.deepEqual([want.won, want.lost], [1, 4], 'a fonte de outubro: a ganha de 4 e a perdida de 23:30 do dia 31; a de 23:30 de 30/09 é de setembro');
  const [[row]] = await env.admin.query("SELECT sum(lost)::int AS lost FROM analytics.rm_crm_outcome WHERE company_id = :c AND month = '2026-10' AND lost_reason = ''", { replacements: { c: t.companyId } });
  assert.equal(row.lost, want.lost, 'o read model guardou o mês de São Paulo');
  const [[sept]] = await env.admin.query("SELECT sum(won)::int AS won FROM analytics.rm_crm_outcome WHERE company_id = :c AND month = '2026-09' AND lost_reason = ''", { replacements: { c: t.companyId } });
  assert.equal(sept.won, 1);
});
