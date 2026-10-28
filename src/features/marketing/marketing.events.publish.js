'use strict';

const crypto = require('node:crypto');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { getCurrentCorrelationId } = require('../../middlewares/correlationId.middleware');
const { SCHEMA_VERSION } = require('./marketing.events.catalog');
const { validatePayload } = require('./marketing.events.validate');

const MAX_KEY = 128;

function defaultKey(type, aggregateId, spec, payload) {
  const parts = [type, aggregateId, ...spec.keyFields.map((f) => String(payload[f]))];
  const key = parts.join(':');
  return key.length <= MAX_KEY ? key : `${type}:${crypto.createHash('sha256').update(key).digest('hex')}`.slice(0, MAX_KEY);
}

/**
 * Publica um evento de Marketing no outbox, NA MESMA transação da mudança de estado (obrigatória: se ela falha, o evento não
 * existe). Valida nome e payload (catálogo do livro, sem dado proibido) e grava o envelope completo em payload_json:
 * {eventId, type, occurredAt, companyId, groupId, correlationId, schemaVersion, payload}. correlationId: o informado, senão o da
 * requisição em curso, senão um novo (jobs sem requisição). Republicar a mesma chave de idempotência devolve o evento já gravado.
 * `idempotencyKey` opcional substitui a chave padrão (tipo + agregado + campos da chave do catálogo).
 */
async function publishMarketingEvent({ type, payload, tenant, correlationId, causationId, idempotencyKey }, transaction) {
  const spec = validatePayload(type, payload);
  const aggregateId = payload[spec.aggregateField];
  const corr = correlationId || getCurrentCorrelationId() || crypto.randomUUID();
  const envelope = {
    eventId: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    companyId: tenant && tenant.companyId,
    groupId: tenant && tenant.groupId,
    correlationId: corr,
    schemaVersion: SCHEMA_VERSION,
    payload,
  };
  return publishDomainEvent({
    groupId: envelope.groupId,
    companyId: envelope.companyId,
    aggregateType: spec.aggregateType,
    aggregateId,
    eventType: type,
    eventVersion: SCHEMA_VERSION,
    payload: envelope,
    idempotencyKey: idempotencyKey || defaultKey(type, aggregateId, spec, payload),
    correlationId: corr,
    causationId,
  }, transaction);
}

module.exports = { publishMarketingEvent };
