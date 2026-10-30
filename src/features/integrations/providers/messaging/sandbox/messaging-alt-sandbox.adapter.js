'use strict';

const { MessagingSandboxBase } = require('./messaging.sandbox.base');
const { messagingEvent, KINDS } = require('../messaging.event');
const { hmacSha256Base64 } = require('../../../registry/webhookVerifiers');
const { texto } = require('../../../registry/webhookSchemas');

const WIRE = Object.freeze({ prefix: 'alt-msg', idField: 'message_id', statusField: 'state', vocab: Object.freeze({ QUEUED: 'accepted', SENT: 'sent', DELIVERED: 'delivered', READ: 'seen', FAILED: 'undelivered' }) });

const STATUS_SCHEMA = Object.freeze({
  type: 'object',
  required: ['event_id', 'event_type', 'message'],
  properties: {
    event_id: texto(160),
    event_type: texto(80),
    message: { type: 'object', additionalProperties: false, required: ['id', 'state'], properties: { id: texto(160), state: { type: 'string', pattern: '^[A-Za-z_]{1,40}$' }, ts: { type: 'integer' } } },
  },
});

const INBOUND_SCHEMA = Object.freeze({
  type: 'object',
  required: ['event_id', 'event_type', 'message'],
  properties: {
    event_id: texto(160),
    event_type: texto(80),
    message: { type: 'object', additionalProperties: false, required: ['id', 'from_number'], properties: { id: texto(160), from_number: texto(40), body: { type: 'string', maxLength: 4096 }, media: texto(400), media_type: texto(120), ts: { type: 'integer' } } },
    contact: { type: 'object', additionalProperties: false, properties: { profile: texto(200) } },
  },
});

const iso = (ts) => (Number.isInteger(ts) ? new Date(ts * 1000).toISOString() : null);

/**
 * messaging-alt-sandbox (M9-D229 3.2 item 5): o segundo fornecedor de mensageria de laboratório, que prova a troca de provider (M9-D221). Formato B: eventos
 * `messages.status` e `messages.inbound` com `event_id`, `message.id`, estados accepted, sent, delivered, seen e undelivered, número do remetente sem o sinal de +, HMAC-SHA256 em base64
 * no cabeçalho `x-alt-signature` (sem horário assinado) e SEM a capacidade `sendMedia` (o domínio degrada de forma declarada). O evento interno que sai daqui é igual ao do `messaging-sandbox`.
 */
class MessagingAltSandboxAdapter extends MessagingSandboxBase {
  providerCode() { return 'messaging-alt-sandbox'; }

  capabilities() { return ['sendText', 'sendTemplate', 'getStatus']; }

  wire() { return WIRE; }

  webhookVerifier() { return hmacSha256Base64({ header: 'x-alt-signature' }); }

  webhookSchemas() { return { 'messages.status': { v1: STATUS_SCHEMA }, 'messages.inbound': { v1: INBOUND_SCHEMA } }; }

  webhookApiVersion() { return null; }

  statusRank() { return { QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5 }; }

  toInternalEvent(payload, meta = {}) {
    const m = payload.message || {};
    if (String(meta.eventType || payload.event_type) === 'messages.inbound') {
      const de = String(m.from_number || '');
      return messagingEvent({ kind: KINDS.INBOUND, externalMessageId: m.id, from: de && !de.startsWith('+') ? `+${de}` : de, name: (payload.contact || {}).profile, text: m.body, mediaRef: m.media, mimeType: m.media_type, occurredAt: iso(m.ts) });
    }
    return messagingEvent({ kind: KINDS.STATUS, externalMessageId: m.id, externalStatus: m.state, occurredAt: iso(m.ts) });
  }
}

module.exports = { MessagingAltSandboxAdapter };
