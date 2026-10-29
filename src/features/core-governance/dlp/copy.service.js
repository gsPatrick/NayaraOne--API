'use strict';

const { withOwnTenantTransaction } = require('./guard.tx');
const { registrarTentativaBloqueada } = require('../../../engines/audit/auditLog.service');
const { requestInvalid, copyDenied, copyFieldUnknown } = require('./dlp.errors');
const { classOfField } = require('./view.fields');
const { emitSignal } = require('./signals.sink');
const guardService = require('./guard.service');

const OUTCOMES = Object.freeze(['ALLOWED', 'DENIED']);
const SENSITIVE = Object.freeze(['HIGH', 'RESTRICTED']);
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

function normalizeBody(body) {
  const resourceType = text(body && body.resourceType, 80);
  const resourceId = text(body && body.resourceId, 128);
  const field = text(body && body.field, 64);
  const outcome = String((body && body.outcome) || '').toUpperCase();
  if (!resourceType || !resourceId || !field || !OUTCOMES.includes(outcome)) {
    throw requestInvalid('Informe resourceType, resourceId, field e outcome (ALLOWED ou DENIED).', { fields: ['resourceType', 'resourceId', 'field', 'outcome'] });
  }
  return { resourceType, resourceId, field, outcome };
}

/** A tela negou a cópia (Ctrl+C, menu ou arrastar em campo RESTRICTED): grava a auditoria de bloqueio e o sinal COPY negado, sempre aceito. */
async function recordDenied(tenant, actor, event, classification) {
  return withOwnTenantTransaction(tenant, actor.userId, async (transaction) => {
    const row = await registrarTentativaBloqueada({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.dlp.copy', entityType: event.resourceType, entityId: null,
      beforeJson: { resourceId: event.resourceId, field: event.field, classification, outcome: 'DENIED' }, reason: 'Tentativa de cópia de dado sensível negada na tela.',
    }, transaction);
    await emitSignal(tenant, {
      actorUserId: actor.userId, action: 'COPY', classification, decision: 'DENY', blockReason: 'POLICY', resourceType: event.resourceType, occurredAt: new Date(), count: 1,
    }, transaction);
    return row.id;
  });
}

/**
 * POST /dlp/copy-events (M9-D825 §3.2b): o servidor REAVALIA a política. `DENIED` é sempre aceito (registro). `ALLOWED` para campo cuja política nega a cópia devolve 403
 * GOV_DLP_DENIED (e o guard já registrou a negação); permitido, o guard audita e entrega o sinal de acesso. Campo fora do registro: 400. LOW e MEDIUM são livres e sem registro.
 */
async function recordCopyEvent(tenant, actor, body, ip, transaction) {
  const event = normalizeBody(body);
  const classification = await classOfField(tenant, event.resourceType, event.field, transaction);
  if (!classification) throw copyFieldUnknown(event.field);
  if (!SENSITIVE.includes(classification)) return { id: null };
  if (event.outcome === 'DENIED') return { id: await recordDenied(tenant, actor, event, classification) };
  const decision = await guardService.decide(tenant, {
    actorUserId: actor.userId, action: 'COPY', resourceType: event.resourceType, resourceIds: [event.resourceId], minClassification: classification, permissions: actor.permissions, ip,
  });
  if (decision.decision === 'DENY') throw copyDenied({ blockReason: decision.blockReason });
  return { id: decision.auditId || null };
}

module.exports = { recordCopyEvent };
