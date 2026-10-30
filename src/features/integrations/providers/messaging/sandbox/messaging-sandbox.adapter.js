'use strict';

const { MessagingSandboxBase } = require('./messaging.sandbox.base');
const { messagingEvent, KINDS } = require('../messaging.event');
const { STATUS } = require('../messaging.status');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { statusEventSchemas, texto } = require('../../../registry/webhookSchemas');

const WIRE = Object.freeze({ prefix: 'sbx-msg', idField: 'id', statusField: 'status', vocab: Object.freeze({ QUEUED: 'QUEUED', SENT: 'SENT', DELIVERED: 'DELIVERED', READ: 'READ', FAILED: 'FAILED' }) });

const INBOUND_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'messageId', 'from'],
  properties: { id: texto(160), type: texto(80), api_version: texto(16), messageId: texto(160), from: texto(40), name: texto(200), text: { type: 'string', maxLength: 4096 }, mediaRef: texto(400), mimeType: texto(120), occurredAt: texto(40) },
});

/**
 * messaging-sandbox (M9-D210 3.1 e M9-D229 3.2 item 5): mensageria simulada, sem rede (formato A de webhook: `message.status` e `message.inbound`, HMAC-SHA256 com horário
 * assinado). Entrega com atraso configurável (`config.sandbox_delivery_delay_ms`) e falhas por cabeçalho `x-sandbox-fail`. O WhatsApp real entra como outro adapter sem tocar o domínio.
 */
class MessagingSandboxAdapter extends MessagingSandboxBase {
  providerCode() { return 'messaging-sandbox'; }

  capabilities() { return ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']; }

  wire() { return WIRE; }

  webhookVerifier() { return hmacWithTimestamp(); }

  webhookSchemas() { return { ...statusEventSchemas(), 'message.inbound': { v1: INBOUND_SCHEMA } }; }

  statusRank() { return { QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5 }; }

  toInternalEvent(payload, meta = {}) {
    if (String(meta.eventType || payload.type) === 'message.inbound') {
      return messagingEvent({ kind: KINDS.INBOUND, externalMessageId: payload.messageId, from: payload.from, name: payload.name, text: payload.text, mediaRef: payload.mediaRef, mimeType: payload.mimeType, occurredAt: payload.occurredAt });
    }
    return messagingEvent({ kind: KINDS.STATUS, externalMessageId: payload.resourceId, externalStatus: payload.status, idempotencyKey: payload.idempotencyKey, occurredAt: payload.occurredAt });
  }
}

module.exports = { MessagingSandboxAdapter, STATUS };
