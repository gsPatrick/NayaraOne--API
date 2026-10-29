'use strict';

const { recordError } = require('../errors/errors.record');
const { REASON_EXHAUSTED } = require('./inbox.constants');
const adapterRegistry = require('../registry/adapterRegistry');
const { pickSchema, allowlistOf } = require('../registry/webhookSchemaPick');

/** Conteúdo a sanitizar e guardar com o erro (M9-D212 3.3): o JSON lido do evento e os campos que o esquema do adapter prevê; sem corpo (ou fora do esquema) fica só o hash. */
function sanitizedParts(row) {
  const payload = row.payload && typeof row.payload === 'object' && row.payload.truncated !== true ? row.payload : undefined;
  const adapter = payload ? adapterRegistry.instantiate(row.providerCode) : null;
  const version = row.apiVersion || (adapter ? adapter.webhookApiVersion(payload, row.headersJson || {}) || adapter.supportedVersions()[0] : null);
  return { payload, allowlist: adapter ? allowlistOf(pickSchema(adapter, row.eventType, version)) : undefined };
}

/**
 * Erro de integração do evento que foi para a fila morta (M9-D250): dá à pessoa o item que ela repete em POST /admin/integrations/errors/:id/retry.
 * Esgotou as tentativas: TRANSIENT (o conteúdo ainda existe, dentro da janela). Dado inválido: UNKNOWN, sem conteúdo guardado (o retry responde 410).
 * Só ids e códigos: nunca o corpo do evento.
 */
function reportDeadLetter(ctx, row, reason, transaction) {
  const esgotou = reason === REASON_EXHAUSTED;
  return recordError(ctx, {
    providerCode: row.providerCode, connectionId: row.connectionId || null, source: 'WEBHOOK', sourceRefId: row.id, operation: 'webhook.inbox',
    errorClass: esgotou ? 'TRANSIENT' : 'UNKNOWN', errorCode: esgotou ? REASON_EXHAUSTED : 'WEBHOOK_PAYLOAD_INVALID',
    message: esgotou ? 'O evento do fornecedor esgotou as tentativas de processamento e foi para a fila morta.' : 'O evento do fornecedor chegou com formato inválido e foi para a fila morta.',
    attempts: Math.max(1, row.attempts || 1), payloadHash: row.payloadHash, ...(esgotou ? sanitizedParts(row) : {}),
  }, transaction);
}

module.exports = { reportDeadLetter };
