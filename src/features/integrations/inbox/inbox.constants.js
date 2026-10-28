'use strict';

/** Constantes da caixa de entrada de webhooks (M9-D203). O banco repete a lista de estados em CHECK. */
const STATUSES = Object.freeze(['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER']);

/** Transições válidas (única fonte de verdade; o teste espelha a tabela). */
const TRANSITIONS = Object.freeze({
  RECEIVED: Object.freeze(['PROCESSING', 'DEAD_LETTER']),
  PROCESSING: Object.freeze(['PROCESSED', 'FAILED']),
  FAILED: Object.freeze(['PROCESSING', 'DEAD_LETTER']),
  PROCESSED: Object.freeze([]),
  DEAD_LETTER: Object.freeze([]),
});

const AUDIT_ACTION = 'integration.webhook.status_changed';
const ENTITY_TYPE = 'IntegrationWebhookInbox';
const MISMATCH_CODE = 'WEBHOOK_PAYLOAD_MISMATCH';
const REASON_EXHAUSTED = 'ATTEMPTS_EXHAUSTED';
const REASON_INVALID = 'SCHEMA_INVALID';

/** Cabeçalhos que NUNCA são gravados, mesmo que o administrador os coloque na lista permitida. */
const HEADERS_NEVER_STORED = Object.freeze(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

module.exports = { STATUSES, TRANSITIONS, AUDIT_ACTION, ENTITY_TYPE, MISMATCH_CODE, REASON_EXHAUSTED, REASON_INVALID, HEADERS_NEVER_STORED };
