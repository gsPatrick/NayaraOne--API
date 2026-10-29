'use strict';

// M9-D627 — números dos read models de Marketing: campanha (custo, leads, atribuídos), entrega por dia e canal, frequência, automações e avaliações.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env627 = require('../_helpers/m9d627Env');

const { src, makeEvent, apply, schedule, rowOf, at } = env627;
let env;
before(async () => { env = await env627.setup(); });
after(() => env627.teardown(env));

const campaignEvent = (tenant, type, campaignId) => makeEvent(tenant, type, { campaignId, startsAt: '2026-10-01T00:00:00Z' });

test('m9d627 campanha de outubro: custo 3200,00, 40 leads, 28 atribuídos e 12 opt-outs', async () => {
  const t = env.tenantA;
  const campaignId = await src.campaign(env, t, { cost: '3200.00' });
  for (let i = 0; i < 40; i += 1) {
    const opp = await src.opportunity(env, t, { campaignId, at: at('2026-10-10') });
    if (i < 28) await src.attribution(env, t, { campaignId, opportunityId: opp, at: at('2026-10-10') });
    else if (i < 31) await src.attribution(env, t, { campaignId, opportunityId: opp, valid: false, at: at('2026-10-10') }); // referência inválida: não atribui
  }
  await src.attribution(env, t, { campaignId, type: 'CLICK', at: at('2026-10-09') }); // clique não é lead
  for (let i = 0; i < 12; i += 1) await src.suppression(env, t, { channel: 'WHATSAPP', at: at('2026-10-15') });
  await src.suppression(env, t, { channel: 'WHATSAPP', reason: 'BOUNCE', at: at('2026-10-15') }); // outro motivo: não é opt-out
  await apply(t, campaignEvent(t, 'marketing.campaign.ended', campaignId));
  const campaign = await rowOf(env, 'rm_mkt_campaigns', t, { campaign_id: campaignId });
  assert.deepEqual([campaign.cost_total, campaign.leads_total, campaign.attributed_leads], ['3200.00', 40, 28]);
  await apply(t, makeEvent(t, 'customer.opted_out', { personId: src.uuid(), channel: 'WHATSAPP', purpose: 'MARKETING', source: 'REPLY', occurredAt: at('2026-10-15').toISOString() }, at('2026-10-15')));
  assert.equal((await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-15', channel: 'WHATSAPP' })).opt_out, 12);
  // o custo vem do Financeiro (cost_actual): quando muda na fonte, o evento seguinte reflete o novo estado, sem delta
  await src.update(env, 'marketing.campaigns', campaignId, { cost_actual: '3350.50' });
  await apply(t, makeEvent(t, 'attribution.recorded', { eventId: src.uuid(), campaignId, eventType: 'LEAD_CREATED', touchRole: 'FIRST' }));
  assert.equal((await rowOf(env, 'rm_mkt_campaigns', t, { campaign_id: campaignId })).cost_total, '3350.50');
});

test('m9d627 entrega por dia e canal: enviadas, entregues, falhas; manual e recebida não contam', async () => {
  const t = env.tenantA;
  const day = at('2026-10-20');
  const ids = [];
  for (const status of ['DELIVERED', 'DELIVERED', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED', 'SENT', 'SENT']) ids.push(await src.message(env, t, { status, at: day }));
  await src.message(env, t, { status: 'DELIVERED', actionKey: null, purpose: null, at: day }); // mensagem manual: sem action_key
  await src.message(env, t, { status: 'RECEIVED', direction: 'INBOUND', actionKey: null, purpose: null, at: day }); // recebida
  await src.message(env, t, { channel: 'EMAIL', status: 'DELIVERED', at: day });
  await src.message(env, t, { status: 'DELIVERED', at: at('2026-10-21', 2) }); // 21/10 02:00Z = 20/10 23:00 em SP: ainda é o dia 20
  await apply(t, makeEvent(t, 'crm.interaction.recorded', { id: ids[0], channel: 'WHATSAPP', direction: 'OUTBOUND' }, day));
  await apply(t, makeEvent(t, 'crm.interaction.recorded', { id: src.uuid(), channel: 'EMAIL', direction: 'OUTBOUND' }, day));
  const wa = await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-20', channel: 'WHATSAPP' });
  assert.deepEqual([wa.sent, wa.delivered, wa.failed], [9, 5, 2], 'o dia é o de São Paulo; DELIVERED+READ entregues; FAILED+UNDELIVERED falhas');
  const mail = await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-20', channel: 'EMAIL' });
  assert.deepEqual([mail.sent, mail.delivered, mail.failed], [1, 1, 0]);
  // o status de entrega chega depois: o evento de mudança de status reflete o novo estado
  await src.update(env, 'crm.messages', ids[6], { status: 'DELIVERED' });
  await apply(t, makeEvent(t, 'crm.message.status_changed', { id: ids[6], channel: 'WHATSAPP', status: 'DELIVERED', day: '2026-10-20' }, at('2026-10-22')));
  assert.equal((await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-20', channel: 'WHATSAPP' })).delivered, 6);
  await apply(t, makeEvent(t, 'crm.interaction.recorded', { id: src.uuid(), channel: 'WHATSAPP', direction: 'INBOUND' }, at('2026-10-22')));
  assert.equal(await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-22', channel: 'WHATSAPP' }), null, 'mensagem recebida não é de Marketing: não abre linha de entrega');
});

test('m9d627 frequência: contatos alcançados e acima do teto (3 mensagens por 7 dias)', async () => {
  const t = env.tenantA;
  const [p1, p2, p3] = [src.uuid(), src.uuid(), src.uuid()];
  for (const d of ['2026-10-17', '2026-10-19', '2026-10-21', '2026-10-22']) await src.message(env, t, { person: p1, at: at(d) }); // 4 na janela: acima do teto
  for (const d of ['2026-10-19', '2026-10-22']) await src.message(env, t, { person: p2, at: at(d) }); // 2: dentro do teto
  await src.message(env, t, { person: p2, channel: 'EMAIL', at: at('2026-10-22') });
  await src.message(env, t, { person: p3, status: 'FAILED', at: at('2026-10-22') }); // falha não conta
  await src.message(env, t, { person: p3, purpose: null, actionKey: null, at: at('2026-10-22') }); // manual não conta
  await apply(t, makeEvent(t, 'crm.interaction.recorded', { id: src.uuid(), channel: 'WHATSAPP', direction: 'OUTBOUND' }, at('2026-10-22')));
  const row = await rowOf(env, 'rm_mkt_frequency', t, { day: '2026-10-22' });
  assert.deepEqual([row.contacts_reached, row.contacts_over_cap], [2, 1]);
});

test('m9d627 automações: executadas, bloqueadas e com falha por dia', async () => {
  const t = env.tenantA;
  const d = at('2026-10-24');
  for (const status of ['COMPLETED', 'COMPLETED', 'STARTED']) await src.run(env, t, { status, startedAt: d, finishedAt: status === 'COMPLETED' ? at('2026-10-24', 16) : null });
  await src.run(env, t, { status: 'BLOCKED', startedAt: d, finishedAt: d });
  await src.run(env, t, { status: 'FAILED', startedAt: d, finishedAt: at('2026-10-24', 17) });
  await src.run(env, t, { status: 'BLOCKED', startedAt: at('2026-10-23'), finishedAt: at('2026-10-24', 18) }); // iniciada ontem, bloqueada hoje
  await apply(t, makeEvent(t, 'automation.run.started', { runId: src.uuid(), flowId: src.uuid(), versionNo: 1, subject: 'PERSON:x' }, d));
  const row = await rowOf(env, 'rm_mkt_automation', t, { day: '2026-10-24' });
  assert.deepEqual([row.executed, row.blocked, row.failed], [5, 2, 1]);
});

test('m9d627 avaliações públicas por mês e plataforma entram pela agenda', async () => {
  const t = env.tenantA;
  const done = at('2026-10-27');
  for (const rating of [5, 4, 5]) await src.review(env, t, { status: 'COMPLETED', platform: 'GOOGLE', rating, completedAt: done, at: at('2026-10-20') });
  await src.review(env, t, { status: 'COMPLETED', platform: 'FACEBOOK', rating: 3, completedAt: done, at: at('2026-10-20') });
  await src.review(env, t, { status: 'COMPLETED', platform: 'GOOGLE', rating: null, completedAt: done, at: at('2026-10-20') }); // sem nota pública: não conta
  await src.review(env, t, { status: 'PENDING', platform: 'GOOGLE', at: at('2026-10-20') });
  await apply(t, makeEvent(t, 'review.requested', { reviewRequestId: src.uuid(), personId: src.uuid(), channel: 'WHATSAPP' }, at('2026-10-20')));
  const before = await rowOf(env, 'rm_mkt_reviews', t, { month: '2026-10', platform: 'SEM_PLATAFORMA' });
  assert.deepEqual([before.reviews, before.rating_sum], [0, 0], 'o pedido abre o mês; a avaliação concluída ainda não chegou');
  await schedule(t);
  const google = await rowOf(env, 'rm_mkt_reviews', t, { month: '2026-10', platform: 'GOOGLE' });
  const facebook = await rowOf(env, 'rm_mkt_reviews', t, { month: '2026-10', platform: 'FACEBOOK' });
  assert.deepEqual([google.reviews, google.rating_sum, facebook.reviews, facebook.rating_sum], [3, 14, 1, 3]);
});
