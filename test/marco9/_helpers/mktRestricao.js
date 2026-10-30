'use strict';

// Apoio dos testes dos lembretes de restrição e regularização (M9-D423): pendência aberta/fechada pelos eventos, automações instaladas e o tick diário das 09:00. Não é teste.
const env = require('./mktRunner');
const { installSeed } = require('../../../src/features/marketing/automations/seeds');
const { PENDING_EVENTS } = require('../../../src/features/marketing/automations/seeds/pendings.consumers');

const { q, uid } = env;
const NINE_SP = (date) => new Date(`${date}T12:00:00.000Z`); // 09:00 em São Paulo (UTC-3)
const OPENED = '2026-11-01T15:00:00Z';

const person = (t, tenant) => env.readyPerson(t, tenant, { phone: null, optIn: [] });
const install = async (t, tenant) => {
  await installSeed({ code: 'RESTRICAO-LEMBRETE', tenant, actor: tenant.userId }, t);
  await installSeed({ code: 'RESTRICAO-EXPIRACAO', tenant, actor: tenant.userId }, t);
};

/** Evento do outbox no formato que o consumidor recebe. */
const pendingEvent = (tenant, type, payload) => ({ id: uid(), eventType: type, groupId: tenant.groupId, companyId: tenant.companyId, occurredAt: new Date(), payloadJson: payload });
const fire = (t, tenant, type, payload) => PENDING_EVENTS[type](pendingEvent(tenant, type, payload), t);

async function openPending(t, tenant, personId, { ref = uid(), kind = 'RESTRICTION', openedAt = OPENED, responsible = tenant.userId } = {}) {
  await fire(t, tenant, 'crm.pending.opened', { pendingId: ref, personId, kind, sourceType: 'OPPORTUNITY', sourceId: uid(), responsibleUserId: responsible, openedAt });
  return ref;
}

const tick = (t, tenant, date) => env.runner.runScheduleTick(tenant, t, { now: NINE_SP(date), mode: 'SANDBOX' });
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const runsOfPerson = (t, personId) => q(t, `SELECT r.id, r.status, r.blocked_reason, r.trigger_event_id, r.actions_result, f.code AS flow_code
  FROM marketing.automation_runs r JOIN marketing.automation_versions v ON v.id = r.automation_version_id JOIN marketing.automation_flows f ON f.id = v.flow_id
  WHERE r.subject_id = :p ORDER BY r.created_at, r.id`, { p: personId });
const sentOn = async (t, personId) => (await q(t, "SELECT created_at, body FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at, id", { p: personId }));

module.exports = { ...env, person, install, fire, openPending, tick, addDays, runsOfPerson, sentOn, NINE_SP, OPENED };
