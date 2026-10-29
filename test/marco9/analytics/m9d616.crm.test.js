'use strict';

// M9-D616 — números dos read models de Comercial/CRM calculados pelo worker a partir da fonte (uma empresa nova por execução).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');

const { src, apply, makeEvent, rows, pick, setSetting } = bi;
let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const created = (id) => makeEvent(env.cX, 'crm.opportunity.created', { id });
const iso = (date, time = '15:00:00') => `${date}T${time}Z`;
const at = (base, seconds) => new Date(Date.parse(base) + seconds * 1000).toISOString();

test('m9d616 leads por dia, origem e corretor, com a primeira resposta em segundos', async () => {
  const [b1, b2] = [src.uuid(), src.uuid()];
  const base = iso('2026-10-20');
  const o1 = await src.opportunity(env, env.cX, { owner: b1, source: 'PORTAL_A', created: base });
  const o2 = await src.opportunity(env, env.cX, { owner: b1, source: 'PORTAL_A', created: base });
  await src.opportunity(env, env.cX, { owner: b2, source: null, created: iso('2026-10-21', '01:30:00') }); // 22:30 de 20/10 em São Paulo
  await src.message(env, env.cX, { opportunity: o1, direction: 'INBOUND', author: 'CLIENT', created: at(base, 60) });
  await src.message(env, env.cX, { opportunity: o1, created: at(base, 600) });
  await src.message(env, env.cX, { opportunity: o2, author: 'NAY', created: at(base, 120) });
  await src.message(env, env.cX, { opportunity: o2, created: at(base, 900) });
  await apply(env.cX, created(o1));
  const list = await rows(env, 'rm_crm_lead_daily', env.cX);
  assert.equal(list.length, 2, 'o dia 2026-10-20 de SP tem duas linhas (a terceira criada às 01:30Z ainda é 20/10 em SP)');
  const a = pick(list, { origin: 'PORTAL_A', broker_id: b1 });
  assert.deepEqual([a.day, a.leads, a.first_response_count, Number(a.first_response_seconds_sum)], ['2026-10-20', 2, 2, 600 + 120], 'a NAY conta como resposta por padrão');
  const none = pick(list, { origin: 'NAO_INFORMADA', broker_id: b2 });
  assert.deepEqual([none.leads, none.first_response_count, Number(none.first_response_seconds_sum)], [1, 0, 0], 'sem resposta não entra na soma');
  await setSetting(env, env.cX, 'analytics.comercial.primeira_resposta_inclui_nay', false);
  await apply(env.cX, makeEvent(env.cX, 'crm.interaction.recorded', { id: src.uuid(), opportunityId: o2, direction: 'OUTBOUND' }));
  const again = pick(await rows(env, 'rm_crm_lead_daily', env.cX), { origin: 'PORTAL_A', broker_id: b1 });
  assert.equal(Number(again.first_response_seconds_sum), 600 + 900, 'com o parâmetro desligado a resposta da NAY não conta');
});

test('m9d616 oportunidades em andamento por estágio, paradas e parâmetro de dias', async () => {
  const b = src.uuid();
  const fresh = iso('2026-10-27');
  const [n1, n2] = [await src.opportunity(env, env.cX, { owner: b, stage: 'NEW', created: fresh }), await src.opportunity(env, env.cX, { owner: b, stage: 'NEW', created: fresh })];
  const stalled = await src.opportunity(env, env.cX, { owner: b, stage: 'NEW', created: iso('2026-10-01') });
  await src.opportunity(env, env.cX, { owner: b, stage: 'QUALIFIED', created: fresh });
  await src.opportunity(env, env.cX, { owner: b, stage: 'CLOSED_WON', created: fresh, closedAt: fresh });
  await apply(env.cX, created(n1));
  let list = await rows(env, 'rm_crm_opportunity_stage', env.cX);
  assert.deepEqual(list.filter((r) => r.broker_id === b).map((r) => [r.stage, r.count, r.stalled_count]).sort(), [['NEW', 3, 1], ['QUALIFIED', 1, 0]], 'o estágio terminal não entra');
  await setSetting(env, env.cX, 'analytics.centro.opp_parada_dias', 30);
  await src.update(env, 'crm.opportunities', n2, { stage: 'QUALIFIED' });
  await apply(env.cX, makeEvent(env.cX, 'crm.opportunity.stage_changed', { id: n2, fromStage: 'NEW', toStage: 'QUALIFIED' }));
  list = await rows(env, 'rm_crm_opportunity_stage', env.cX);
  assert.deepEqual(list.filter((r) => r.broker_id === b).map((r) => [r.stage, r.count, r.stalled_count]).sort(), [['NEW', 2, 0], ['QUALIFIED', 2, 0]], 'um evento move a contagem do estágio de saída para o de entrada; 27 dias não é parada com limite de 30');
  await src.message(env, env.cX, { opportunity: stalled, direction: 'INBOUND', author: 'CLIENT', created: iso('2026-10-28', '12:00:00') });
  await setSetting(env, env.cX, 'analytics.centro.opp_parada_dias', 7);
  await apply(env.cX, makeEvent(env.cX, 'crm.opportunity.stage_changed', { id: stalled, fromStage: 'NEW', toStage: 'NEW' }));
  assert.equal(pick(await rows(env, 'rm_crm_opportunity_stage', env.cX), { stage: 'NEW', broker_id: b }).stalled_count, 0, 'mensagem recente tira a oportunidade da lista de paradas');
});

test('m9d616 desfechos por mês de São Paulo e motivos de perda', async () => {
  const b = src.uuid();
  const make = (stage, closedAt, lostReason) => src.opportunity(env, env.cX, { owner: b, stage, closedAt, lostReason, created: iso('2026-09-01') });
  const won = await make('CLOSED_WON', iso('2026-10-10'));
  await make('CLOSED_WON', iso('2026-11-01', '01:00:00')); // 22:00 de 31/10 em SP: ainda outubro
  await make('CLOSED_LOST', iso('2026-10-12'), 'PRICE');
  await make('CLOSED_LOST', iso('2026-10-13'), null);
  await make('WITHDRAWN', iso('2026-10-14'));
  await make('CLOSED_WON', iso('2026-11-02'));
  await apply(env.cX, makeEvent(env.cX, 'crm.opportunity.won', { id: won, closedAt: iso('2026-10-10') }));
  const list = (await rows(env, 'rm_crm_outcome', env.cX)).filter((r) => r.broker_id === b);
  const totals = pick(list, { month: '2026-10', lost_reason: '' });
  assert.deepEqual([totals.won, totals.lost, totals.withdrawn], [2, 2, 1]);
  assert.equal(pick(list, { month: '2026-10', lost_reason: 'PRICE' }).lost_count, 1);
  assert.equal(pick(list, { month: '2026-10', lost_reason: 'NAO_INFORMADO' }).lost_count, 1);
  assert.equal(list.filter((r) => r.month === '2026-11').length, 0, 'novembro só entra quando o evento ou a agenda o recalcula');
});

test('m9d616 carteira sem próxima ação por corretor', async () => {
  const b = src.uuid();
  const a = await src.opportunity(env, env.cX, { owner: b, stage: 'NEW', nextAction: 'Ligar amanhã' });
  await src.opportunity(env, env.cX, { owner: b, stage: 'NEW' });
  await src.opportunity(env, env.cX, { owner: b, stage: 'VISIT', nextAction: '   ' });
  await src.opportunity(env, env.cX, { owner: b, stage: 'CLOSED_LOST', closedAt: iso('2026-10-10') });
  await apply(env.cX, created(a));
  const r = pick(await rows(env, 'rm_crm_next_action', env.cX), { broker_id: b });
  assert.deepEqual([r.open_total, r.without_next_action], [3, 2], 'texto vazio ou só espaços é sem próxima ação; encerrada não conta');
});

test('m9d616 visitas e propostas por dia', async () => {
  const [v1, , ] = [await src.visit(env, env.cX, { at: iso('2026-10-27'), status: 'SCHEDULED' }), await src.visit(env, env.cX, { at: iso('2026-10-27'), status: 'DONE' }), await src.visit(env, env.cX, { at: iso('2026-10-27'), status: 'CANCELED' })];
  const p1 = await src.proposal(env, env.cX, { status: 'SENT', sentAt: iso('2026-10-27') });
  await src.proposal(env, env.cX, { status: 'SENT', sentAt: iso('2026-10-27') });
  const p3 = await src.proposal(env, env.cX, { status: 'ACCEPTED', sentAt: iso('2026-10-27'), decidedAt: iso('2026-10-28') });
  await apply(env.cX, makeEvent(env.cX, 'crm.visit.completed', { id: v1 }));
  await apply(env.cX, makeEvent(env.cX, 'crm.proposal.created', { id: p1 }));
  await apply(env.cX, makeEvent(env.cX, 'crm.proposal.status_changed', { id: p3, fromStatus: 'SENT', toStatus: 'ACCEPTED' }));
  const list = await rows(env, 'rm_crm_visits_proposals', env.cX);
  const d27 = pick(list, { day: '2026-10-27' });
  assert.deepEqual([d27.visits_scheduled, d27.visits_done, d27.proposals_sent, d27.proposals_accepted], [2, 1, 3, 0], 'cancelada não é agendada; envio no dia do envio');
  assert.deepEqual([pick(list, { day: '2026-10-28' }).proposals_accepted], [1], 'aceite no dia da decisão');
});
