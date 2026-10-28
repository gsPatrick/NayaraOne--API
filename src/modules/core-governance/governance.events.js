'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');
const { govError } = require('./governance.errors');

/**
 * Catálogo FECHADO de eventos do bloco de governança (Caderno, Governança §10): 7 tipos. Nenhum outro evento de domínio é
 * criado pelo bloco, exceto os eventos de origem que M9-D803 manda publicar em obras e jurídico (esses não passam por aqui;
 * pertencem aos módulos de origem). O que o livro não lista fica em `registrarAuditoria`.
 */
const GOVERNANCE_EVENT_TYPES = Object.freeze([
  'calendar.item.updated',
  'data.quality.issue.opened',
  'dlp.export.blocked',
  'bcp.manual_operation.recorded',
  'bcp.manual_operation.imported',
  'api.consumer.deprecation_due',
  'finops.budget.threshold',
]);

/**
 * Publica um evento do catálogo na MESMA transação da operação (outbox). `idempotencyKey` é obrigatória; tipo fora do
 * catálogo é recusado antes de qualquer escrita.
 */
async function publishGovernanceEvent(event, transaction) {
  if (!event || !GOVERNANCE_EVENT_TYPES.includes(event.eventType)) {
    throw govError(500, 'GOV_EVENT_UNKNOWN', 'Tipo de evento fora do catálogo de governança.', { eventType: event && event.eventType });
  }
  if (!event.idempotencyKey) {
    throw govError(500, 'GOV_EVENT_IDEMPOTENCY_REQUIRED', 'Todo evento de governança exige idempotencyKey.', { eventType: event.eventType });
  }
  return publishDomainEvent(event, transaction);
}

module.exports = { GOVERNANCE_EVENT_TYPES, publishGovernanceEvent };
