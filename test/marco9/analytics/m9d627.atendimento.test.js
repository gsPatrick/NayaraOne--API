'use strict';

// M9-D627 — números dos read models de Atendimento/Satisfação: satisfação, reclamações por motivo e SLA de resolução; e o evento de status de
// entrega que o serviço de mensagens publica.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env627 = require('../_helpers/m9d627Env');
const { updateMessageStatus } = require('../../../src/features/crm/messages.service');

const { src, makeEvent, apply, rowOf, at, inTx } = env627;
let env;
before(async () => { env = await env627.setup(); });
after(() => env627.teardown(env));

test('m9d627 satisfação: respostas e soma das notas do mês', async () => {
  const t = env.tenantA;
  for (const [score, status] of [[5, 'COMPLETED'], [4, 'COMPLETED'], [2, 'BLOCKED_NEGATIVE']]) {
    await src.review(env, t, { status, score, completedAt: at('2026-09-15'), at: at('2026-09-10') });
  }
  await src.review(env, t, { status: 'SENT', at: at('2026-09-10') }); // ainda sem resposta: não conta
  await src.review(env, t, { status: 'COMPLETED', score: 5, completedAt: at('2026-08-15'), at: at('2026-08-10') }); // outro mês
  await apply(t, makeEvent(t, 'review.requested', { reviewRequestId: src.uuid(), personId: src.uuid(), channel: 'WHATSAPP' }, at('2026-09-15')));
  const row = await rowOf(env, 'rm_support_satisfaction', t, { month: '2026-09' });
  assert.deepEqual([row.responses, row.score_sum], [3, 11]);
});

test('m9d627 reclamações por motivo: reclamação e conflito, elogio não conta', async () => {
  const t = env.tenantA;
  const month = at('2026-07-10');
  for (let i = 0; i < 3; i += 1) await src.feedbackCase(env, t, { type: 'COMPLAINT', at: month, slaDueAt: at('2026-07-13') });
  await src.feedbackCase(env, t, { type: 'CONFLICT', at: month, slaDueAt: at('2026-07-13') });
  await src.feedbackCase(env, t, { type: 'COMPLIMENT', at: month, slaDueAt: at('2026-07-13') });
  await apply(t, makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'COMPLAINT', severity: 'HIGH', slaDueAt: at('2026-07-13').toISOString() }, month));
  await apply(t, makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'CONFLICT', severity: 'LOW', slaDueAt: at('2026-07-17').toISOString() }, month));
  await apply(t, makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'COMPLIMENT', severity: 'LOW', slaDueAt: at('2026-07-17').toISOString() }, month));
  assert.equal((await rowOf(env, 'rm_support_complaints', t, { month: '2026-07', reason: 'COMPLAINT' })).count, 3);
  assert.equal((await rowOf(env, 'rm_support_complaints', t, { month: '2026-07', reason: 'CONFLICT' })).count, 1);
  assert.equal(await rowOf(env, 'rm_support_complaints', t, { month: '2026-07', reason: 'COMPLIMENT' }), null);
});

test('m9d627 SLA de resolução: resolvidos, dentro do prazo e vencidos em aberto', async () => {
  const t = env.tenantA;
  const created = at('2026-08-03');
  await src.feedbackCase(env, t, { status: 'RESOLVED', at: created, slaDueAt: at('2026-08-06'), resolvedAt: at('2026-08-05') }); // no prazo
  await src.feedbackCase(env, t, { status: 'RESOLVED', type: 'CONFLICT', at: created, slaDueAt: at('2026-08-06'), resolvedAt: at('2026-08-06') }); // no limite: no prazo
  await src.feedbackCase(env, t, { status: 'RESOLVED', at: created, slaDueAt: at('2026-08-06'), resolvedAt: at('2026-08-20') }); // fora do prazo
  await src.feedbackCase(env, t, { status: 'OPEN', at: created, slaDueAt: at('2026-08-10') }); // aberto e vencido (agosto): o prazo é a abertura mais as horas da prioridade (M9-D672)
  await src.feedbackCase(env, t, { status: 'ESCALATED', at: created, slaDueAt: at('2026-08-12') }); // escalado e vencido
  await src.feedbackCase(env, t, { status: 'IN_PROGRESS', at: created, slaDueAt: at('2026-08-28') }); // aberto, vencido antes de 28/10: conta
  await src.feedbackCase(env, t, { status: 'OPEN', at: at('2026-10-27'), slaDueAt: at('2026-11-02') }); // aberto há 1 dia: o prazo de 72 h (prioridade média, M9-D672) ainda não venceu
  await apply(t, makeEvent(t, 'crm.feedback_case.resolved', { id: src.uuid(), resolvedAt: at('2026-08-20').toISOString(), withinSla: false }, at('2026-08-20')));
  const row = await rowOf(env, 'rm_support_sla', t, { month: '2026-08' });
  assert.deepEqual([row.resolved, row.within_sla, row.open_overdue], [3, 2, 3]);
  await apply(t, makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'COMPLAINT', severity: 'LOW', slaDueAt: at('2026-11-02').toISOString() }, at('2026-10-26')));
  const november = await rowOf(env, 'rm_support_sla', t, { month: '2026-11' });
  assert.deepEqual([november.resolved, november.within_sla, november.open_overdue], [0, 0, 0], 'prazo em novembro ainda não venceu em 28/10');
});

test('m9d627 mudança de status da mensagem publica o evento com o dia de criação em SP', async () => {
  const t = env.tenantB;
  const id = await src.message(env, t, { status: 'SENT', channel: 'EMAIL', at: new Date('2026-10-21T02:30:00Z') }); // 20/10 23:30 em SP
  await inTx(t, { commit: true }, (tx) => updateMessageStatus(id, 'delivered', t.userId, tx));
  await inTx(t, { commit: true }, (tx) => updateMessageStatus(id, 'DELIVERED', t.userId, tx)); // mesmo status: sem novo evento
  const [events] = await env.admin.query("SELECT payload_json FROM integration.outbox_events WHERE event_type = 'crm.message.status_changed' AND company_id = :c AND aggregate_id = :id", { replacements: { c: t.companyId, id } });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload_json, { id, channel: 'EMAIL', status: 'DELIVERED', day: '2026-10-20' });
});
