'use strict';

const crypto = require('node:crypto');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events');
const repo = require('./tracking.events.repository');
const { EVENT_TYPES, EVIDENCE_REQUIRED } = require('./tracking.catalog');
const { evidenceRequired, invalidInput } = require('./tracking.errors');

const isFilled = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim());

/** Evento sem evidência não é gravado: 422 MKT_ATTRIBUTION_EVIDENCE_REQUIRED, com as chaves que faltam. */
function assertEvidence(eventType, evidence) {
  if (!EVENT_TYPES.includes(eventType)) throw invalidInput('Tipo de evento de atribuição inválido.', { eventType });
  const missing = EVIDENCE_REQUIRED[eventType].filter((k) => !evidence || typeof evidence !== 'object' || !isFilled(evidence[k]));
  if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).length === 0 || missing.length > 0) {
    throw evidenceRequired({ eventType, missing: missing.length > 0 ? missing : EVIDENCE_REQUIRED[eventType] });
  }
}

const roleCode = (roles) => (roles.includes('FIRST') && roles.includes('LAST') ? 'BOTH' : roles[0] || 'NONE');

/** attribution.recorded: só eventos válidos com campanha (o contrato do evento exige campanha), sem dado pessoal (id ou hash). */
async function emitRecorded(tenant, event, sessionHash, transaction) {
  if (!event.valid || !event.campaign_id) return;
  const payload = { eventId: event.id, campaignId: event.campaign_id, eventType: event.event_type, touchRole: roleCode(event.touch_roles || []) };
  if (event.person_id) payload.personId = event.person_id;
  else payload.personHash = sessionHash || crypto.createHash('sha256').update(event.id).digest('hex');
  await publishMarketingEvent({ type: 'attribution.recorded', payload, tenant, idempotencyKey: `attribution.recorded:${event.id}` }, transaction);
}

/**
 * Grava um evento de atribuição com evidência obrigatória. A mesma `dedupeKey` devolve o evento já gravado (replay) sem emitir de novo.
 * `sessionHash` só serve para o hash do evento de um clique anônimo.
 */
async function recordEvent({ tenant, actor, eventType, evidence, sessionHash, ...fields }, transaction) {
  assertEvidence(eventType, evidence);
  const { event, replay } = await repo.insertEvent(tenant, actor, { eventType, evidence, occurredAt: new Date(), ...fields }, transaction);
  if (!replay) await emitRecorded(tenant, event, sessionHash, transaction);
  return { event, replay };
}

async function auditEvent(tenant, actor, action, event, reason, transaction) {
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action, entityType: 'marketing.attribution_event', entityId: event.id,
    beforeJson: null, afterJson: { eventType: event.event_type, campaignId: event.campaign_id, touchRoles: event.touch_roles, valid: event.valid }, reason,
  }, transaction);
}

module.exports = { assertEvidence, recordEvent, emitRecorded, auditEvent, roleCode };
