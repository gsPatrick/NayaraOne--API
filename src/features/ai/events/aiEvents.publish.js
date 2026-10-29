'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { CATALOG, EVENT_VERSION, CLASSIFICATION } = require('./aiEvents.catalog');
const { check, MISSING } = require('./aiEvents.types');
const { incomplete } = require('./aiEvents.errors');

/** Monta o payload SÓ com os campos do catálogo; campo obrigatório ausente ou inválido recusa o evento inteiro. */
function buildPayload(type, spec, data) {
  const payload = {};
  const bad = [];
  for (const [field, kind] of Object.entries(spec.fields)) {
    const value = check(kind, data ? data[field] : undefined);
    if (value === MISSING) bad.push(field);
    else payload[field] = value;
  }
  if (bad.length) throw incomplete({ eventType: type, fields: bad });
  return payload;
}

/**
 * Publica um evento ai.* no outbox NA MESMA transação do dado (obrigatória; sem ela o outbox recusa). `tenant` = { groupId,
 * companyId }. A chave de idempotência é a da tabela da demanda: republicar é no-op e devolve o evento já gravado.
 * Evento desconhecido, campo faltando ou dado pessoal: 500 AI_OUTBOX_EVENT_INCOMPLETE e a operação do chamador é desfeita.
 */
async function publishAiEvent(tenant, type, data, transaction, { correlationId } = {}) {
  const spec = CATALOG[type];
  if (!spec) throw incomplete({ eventType: type, reason: 'UNKNOWN_EVENT' });
  const payload = buildPayload(type, spec, data);
  return publishDomainEvent({
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    aggregateType: spec.aggregateType,
    aggregateId: payload[spec.aggregateField],
    eventType: type,
    eventVersion: EVENT_VERSION,
    classification: CLASSIFICATION,
    payload,
    idempotencyKey: spec.key(payload),
    correlationId,
  }, transaction);
}

module.exports = { publishAiEvent, buildPayload };
