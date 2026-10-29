'use strict';

// Cenário da M9-D627 para o teste de rebuild: fontes de Marketing e Atendimento de UMA empresa (tudo dentro da janela de 7 dias da agenda e de
// outubro/2026) e os eventos que o outbox entregaria. Os agregados que só a agenda descobre (plataforma da avaliação, falha de run) entram pela passada.
const { src, makeEvent, at } = require('./m9d627Env');

async function seed(env, t) {
  const campaignId = await src.campaign(env, t, { cost: '100.00' });
  const lead = await src.opportunity(env, t, { campaignId, at: at('2026-10-25') });
  await src.opportunity(env, t, { campaignId, at: at('2026-10-25') });
  await src.attribution(env, t, { campaignId, opportunityId: lead, at: at('2026-10-25') });
  const [p1, p2] = [src.uuid(), src.uuid()];
  for (const status of ['DELIVERED', 'FAILED', 'SENT']) await src.message(env, t, { person: p1, status, at: at('2026-10-26') });
  await src.message(env, t, { person: p2, status: 'READ', at: at('2026-10-26') });
  await src.message(env, t, { person: p2, channel: 'EMAIL', status: 'DELIVERED', at: at('2026-10-27') });
  await src.suppression(env, t, { channel: 'WHATSAPP', at: at('2026-10-27') });
  await src.run(env, t, { status: 'COMPLETED', startedAt: at('2026-10-25'), finishedAt: at('2026-10-25', 16) });
  await src.run(env, t, { status: 'FAILED', startedAt: at('2026-10-25'), finishedAt: at('2026-10-26') });
  await src.review(env, t, { status: 'COMPLETED', platform: 'GOOGLE', rating: 5, score: 5, completedAt: at('2026-10-27'), at: at('2026-10-26') });
  await src.review(env, t, { status: 'BLOCKED_NEGATIVE', score: 2, completedAt: at('2026-10-27'), at: at('2026-10-26') });
  await src.feedbackCase(env, t, { type: 'COMPLAINT', status: 'RESOLVED', at: at('2026-10-26'), slaDueAt: at('2026-10-29'), resolvedAt: at('2026-10-27') });
  await src.feedbackCase(env, t, { type: 'CONFLICT', status: 'OPEN', at: at('2026-10-26'), slaDueAt: at('2026-10-27') });
  await src.feedbackCase(env, t, { type: 'COMPLAINT', status: 'OPEN', at: at('2026-10-26'), slaDueAt: at('2026-12-01') });
  return [
    makeEvent(t, 'marketing.campaign.started', { campaignId, startsAt: '2026-10-25T00:00:00Z' }, at('2026-10-25')),
    makeEvent(t, 'crm.interaction.recorded', { id: src.uuid(), channel: 'WHATSAPP', direction: 'OUTBOUND' }, at('2026-10-26')),
    makeEvent(t, 'crm.interaction.recorded', { id: src.uuid(), channel: 'EMAIL', direction: 'OUTBOUND' }, at('2026-10-27')),
    makeEvent(t, 'customer.opted_out', { personId: p1, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'REPLY', occurredAt: at('2026-10-27').toISOString() }, at('2026-10-27')),
    makeEvent(t, 'automation.run.started', { runId: src.uuid(), flowId: src.uuid(), versionNo: 1, subject: 'PERSON:x' }, at('2026-10-25')),
    makeEvent(t, 'review.requested', { reviewRequestId: src.uuid(), personId: p1, channel: 'WHATSAPP' }, at('2026-10-26')),
    makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'COMPLAINT', severity: 'HIGH', slaDueAt: at('2026-10-29').toISOString() }, at('2026-10-26')),
    makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'CONFLICT', severity: 'LOW', slaDueAt: at('2026-10-27').toISOString() }, at('2026-10-26')),
    makeEvent(t, 'crm.feedback_case.resolved', { id: src.uuid(), resolvedAt: at('2026-10-27').toISOString(), withinSla: true }, at('2026-10-27')),
  ];
}

module.exports = { seed };
