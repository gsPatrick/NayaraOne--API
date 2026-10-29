'use strict';

// M9-D631 — crm.loss_reasons e crm.portfolio_without_next_action: o número do KPI refeito do zero só com as oportunidades e tarefas da fonte, a regra de
// qualidade (sem motivo, sem corretor), o fuso de São Paulo e os parâmetros do administrador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/crmKpiEnv');
const { outcomesFromSource, portfolioFromSource } = require('../_helpers/crmOracle631');

const { src, at, opp, task, TODAY } = kit;
const TOMORROW_START = '2026-10-29T03:00:00.000Z'; // 00:00 de 29/10 em São Paulo
const TODAY_START = '2026-10-28T03:00:00.000Z';
let env;
let taskIds;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

const dim = (t, code, key, asOfDate = TODAY) => kit.dimension(t, code, key, asOfDate);

test('m9d631 reproduz crm.loss_reasons a partir dos registros-fonte', async () => {
  const t = env.cX;
  const { ids, closed } = await kit.augustOutcomes(env, t);
  await kit.refreshAll(t, ids, closed);
  await kit.setSetting(env, t, 'analytics.qualidade.max_sem_motivo_pct', 25); // 3 de 14 sem motivo (21,43%) passam com limite de 25%
  await kit.kpis(t, '2026-08-31');
  const want = await outcomesFromSource(env, t, '2026-08-31');
  assert.deepEqual(want.byReason, { PRICE: 6, CLIENT_GAVE_UP: 5, NAO_INFORMADO: 3 });
  assert.equal(want.lost, 14);
  const kpi = await kit.readKpi(t, 'crm.loss_reasons', { asOfDate: '2026-08-31' });
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'crm.loss_reasons']);
  assert.equal(Number(kpi.value), want.lost, 'o total é o número de perdidas da fonte');
  let sum = 0;
  for (const [reason, count] of Object.entries(want.byReason)) {
    assert.equal(Number(await dim(t, 'crm.loss_reasons', `motivo:${reason}`, '2026-08-31')), count, `contagem de ${reason}`);
    assert.equal(Number(await dim(t, 'crm.loss_reasons', `motivo:${reason}:parte_pct`, '2026-08-31')), Number(want.reasonPercent[reason]), `percentual de ${reason}`);
    sum += count;
  }
  assert.equal(sum, Number(kpi.value), 'os motivos somam o total de perdidas');
  assert.equal(kpi.sourceRefs[0].count, want.lost, 'o detalhe abre as perdidas do mês');
});

test('m9d631 crm.loss_reasons fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.qualidade.max_sem_motivo_pct', 5); // o padrão do livro
  await kit.kpis(t, '2026-08-31');
  const bad = await kit.readKpi(t, 'crm.loss_reasons', { asOfDate: '2026-08-31' });
  assert.equal(bad.status, 'DEGRADED', '3 de 14 sem motivo (21,43%) passa dos 5% padrão');
  assert.equal(bad.value, null, 'nunca um número enganoso');
});

test('m9d631 loss_reasons - timezone: perda às 23:30 de São Paulo cai no mês certo (motivos de perda)', async () => {
  const t = env.cY;
  const ids = [];
  const closed = {};
  for (const closedAt of ['2026-11-01T02:30:00Z', '2026-10-01T02:30:00Z']) { // 23:30 de 31/10 (outubro) e 23:30 de 30/09 (setembro) em SP
    const id = await opp(env, t, { owner: src.uuid(), stage: 'CLOSED_LOST', created: '2026-08-01T15:00:00Z', closedAt, lostReason: 'PRICE' });
    ids.push(id);
    closed[id] = 'lost';
  }
  await kit.refreshAll(t, ids, closed);
  const out = (await kit.kpis(t, '2026-10-31')).kpis['crm.loss_reasons'];
  assert.equal(out.value, '1', 'só a de 23:30 do dia 31 é de outubro');
  assert.equal((await outcomesFromSource(env, t, '2026-10-31')).lost, 1);
});

test('m9d631 reproduz crm.portfolio_without_next_action a partir dos registros-fonte', async () => { // exemplo da demanda: 92 em aberto, 17 sem ação => 17 e 18,48%
  const t = env.cX;
  const [b1, b2] = [src.uuid(), src.uuid()];
  const ids = [];
  const add = async (c) => { const id = await opp(env, t, { created: at(1), updated: at(20), ...c }); ids.push(id); return id; };
  const dueLater = '2026-11-05T15:00:00Z';
  for (let i = 0; i < 65; i += 1) await add({ owner: i % 2 ? b1 : b2, stage: 'NEW', nextAction: 'Ligar para o cliente', nextActionDueAt: dueLater }); // válidas: texto e data
  taskIds = [];
  for (let i = 0; i < 10; i += 1) { // válidas: tarefa aberta com vencimento depois de hoje, sem próxima ação preenchida
    const id = await add({ owner: b1, stage: 'VISIT_SCHEDULED' });
    await task(env, t, { opportunity: id, dueAt: '2026-10-30T15:00:00Z' });
  }
  for (let i = 0; i < 10; i += 1) await add({ owner: b2, stage: 'NEW' }); // sem nada
  for (let i = 0; i < 3; i += 1) await add({ owner: b1, stage: 'NEW', nextAction: 'Ligar' }); // texto sem data: inválida pelo validador
  for (let i = 0; i < 2; i += 1) { const id = await add({ owner: b1, stage: 'VISIT_SCHEDULED' }); await task(env, t, { opportunity: id, status: 'DONE', dueAt: '2026-10-30T15:00:00Z' }); } // tarefa concluída não vale
  for (let i = 0; i < 2; i += 1) { const id = await add({ owner: b2, stage: 'VISIT_SCHEDULED' }); taskIds.push({ id, task: await task(env, t, { opportunity: id, dueAt: '2026-10-28T21:00:00Z' }) }); } // tarefa de hoje: não é posterior a hoje
  await add({ owner: b1, stage: 'CLOSED_WON', closedAt: at(20) }); // encerrada não conta
  const gone = await add({ owner: b1, stage: 'NEW' });
  await src.update(env, 'crm.opportunities', gone, { deleted_at: at(21) }); // excluída não conta
  await kit.refreshAll(t, ids);
  await kit.kpis(t);

  const want = await portfolioFromSource(env, t, TOMORROW_START);
  assert.deepEqual([want.open, want.without, want.percent], ['92', '17', '18.48']);
  const kpi = await kit.readKpi(t, 'crm.portfolio_without_next_action');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'COUNT', 1]);
  assert.equal(Number(kpi.value), Number(want.without), 'a contagem do KPI é a da fonte');
  assert.equal(Number(await dim(t, 'crm.portfolio_without_next_action', 'sem_acao_pct')), 18.48);
  assert.equal(Number(await dim(t, 'crm.portfolio_without_next_action', 'em_aberto_qtd')), 92);
  assert.equal(Number(await dim(t, 'crm.portfolio_without_next_action', 'estagio:NEW')), want.byStage.NEW);
  assert.equal(Number(await dim(t, 'crm.portfolio_without_next_action', 'estagio:VISIT_SCHEDULED')), want.byStage.VISIT_SCHEDULED);
  assert.equal(kpi.sourceRefs[0].count, 17, 'o detalhe abre exatamente as oportunidades sem ação');
  await kit.inTx(t, {}, async (tx) => {
    const r = await kit.registry.reconcileDetail(kit.ctxOf(t), 'crm.portfolio_without_next_action', kpi.sourceRefs[0], kpi.value, { unit: 'COUNT' }, tx);
    assert.equal(r.ok, true, `detalhe ${r.detail} x KPI ${r.kpi}`);
  });
});

test('m9d631 a tarefa de hoje só vale como próxima ação se o administrador ligar analytics.comercial.proxima_acao_inclui_hoje', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.comercial.proxima_acao_inclui_hoje', true);
  for (const { id, task: taskId } of taskIds) await kit.apply(t, kit.makeEvent(t, 'crm.task.updated', { id: taskId, opportunityId: id })); // o evento da tarefa recalcula a carteira do corretor
  await kit.kpis(t);
  const want = await portfolioFromSource(env, t, TODAY_START);
  assert.equal(want.without, '15');
  assert.equal(Number((await kit.readKpi(t, 'crm.portfolio_without_next_action')).value), 15, 'as 2 tarefas de hoje passam a valer');
});

test('m9d631 crm.portfolio_without_next_action fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => { // oportunidade em aberto sem corretor
  const t = env.cY;
  const ids = [];
  for (let i = 0; i < 9; i += 1) ids.push(await opp(env, t, { owner: src.uuid(), stage: 'NEW', created: at(1), updated: at(20), nextAction: 'Ligar', nextActionDueAt: '2026-11-05T15:00:00Z' }));
  ids.push(await opp(env, t, { owner: null, stage: 'NEW', created: at(1), updated: at(20) }));
  await kit.refreshAll(t, ids);
  await kit.kpis(t);
  const bad = await kit.readKpi(t, 'crm.portfolio_without_next_action');
  assert.equal(bad.status, 'DEGRADED', 'oportunidade em aberto sem corretor');
  assert.equal(bad.value, null);
  await kit.setSetting(env, t, 'analytics.qualidade.max_oportunidade_sem_corretor_pct', 10);
  await kit.kpis(t);
  const ok = await kit.readKpi(t, 'crm.portfolio_without_next_action');
  assert.equal(ok.status, 'OK', '1 de 10 sem corretor (10%) passa com limite de 10%');
  assert.equal(Number(ok.value), 1);
});
