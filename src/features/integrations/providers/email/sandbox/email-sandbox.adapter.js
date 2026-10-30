'use strict';

const { EmailAdapter } = require('../email.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { texto } = require('../../../registry/webhookSchemas');
const store = require('./email.sandbox.store');
const { emailEvent, emailReceivedEvent, KINDS } = require('./email.sandbox.event');
const { INBOUND_SCHEMA } = require('./email.sandbox.inbound');

const STATUS = Object.freeze({ QUEUED: 'QUEUED', SENT: 'SENT', DELIVERED: 'DELIVERED', BOUNCED_SOFT: 'BOUNCED_SOFT', BOUNCED_HARD: 'BOUNCED_HARD', COMPLAINED: 'COMPLAINED', FAILED: 'FAILED', RECEIVED: 'RECEIVED' });
const TYPES = Object.freeze({ 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed' });

const SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'message'],
  properties: {
    id: texto(160),
    type: { type: 'string', enum: Object.keys(TYPES) },
    api_version: texto(16),
    message: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: texto(160) } },
    bounce: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['hard', 'soft'] }, reason: texto(300) } },
    reason: texto(300),
    occurredAt: texto(40),
  },
});

/** Evento do provedor -> tipo interno: o bounce traz hard ou soft; sem a classificação, o evento é tratado como soft (a menos grave, nunca presume hard). */
function kindOf(payload) {
  if (payload.type === 'email.delivered') return KINDS.DELIVERED;
  if (payload.type === 'email.complained') return KINDS.COMPLAINED;
  if (payload.type === 'email.failed') return KINDS.FAILED;
  return payload.bounce && payload.bounce.type === 'hard' ? KINDS.BOUNCED_HARD : KINDS.BOUNCED_SOFT;
}

/**
 * email-sandbox (M9-D234): e-mail simulado, sem rede, com webhook de eventos (HMAC-SHA256 com horário assinado em `x-signature`). O envio devolve o identificador da
 * mensagem e status SENT; DELIVERED, BOUNCED_SOFT, BOUNCED_HARD, COMPLAINED e FAILED só chegam pelo evento do provedor. Um e-mail para `rejeitar@...` é recusado pelo
 * provedor (422, sem nova tentativa) para exercitar a falha definitiva.
 */
class EmailSandboxAdapter extends EmailAdapter {
  providerCode() { return 'email-sandbox'; }

  capabilities() { return ['sendEmail', 'getDeliveryStatus', 'receiveInbound']; }

  supportedVersions() { return ['v1']; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  supportsIdempotency(operation) { return operation === 'sendEmail'; }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  webhookVerifier() { return hmacWithTimestamp(); }

  webhookSchemas() { return { '*': { v1: SCHEMA }, 'email.received': { v1: INBOUND_SCHEMA } }; }

  /** Ordem dos status (M9-D212): o soft bounce pode ser superado pela entrega; a reclamação vale mais que o bounce; evento mais antigo que o aplicado não regride a mensagem. */
  statusRank() { return { QUEUED: 1, SENT: 2, BOUNCED_SOFT: 3, DELIVERED: 4, BOUNCED_HARD: 5, COMPLAINED: 6, FAILED: 7 }; }

  toInternalEvent(payload) {
    if (payload.type === 'email.received') return emailReceivedEvent(payload.message);
    return emailEvent({ kind: kindOf(payload), messageId: payload.message.id, reason: (payload.bounce && payload.bounce.reason) || payload.reason || null, occurredAt: payload.occurredAt || null });
  }

  async sendEmail(ctx, request, meta) {
    const destinos = [].concat(request.to || []).map(String);
    if (destinos.some((d) => d.toLowerCase().startsWith('rejeitar@'))) throw store.erroHttp(422, 'Destinatário recusado pelo provedor');
    const chave = (meta && meta.idempotencyKey) || `${destinos.join(',')}|${request.subject}`;
    const m = store.send(ctx.connection.id, chave, request);
    return { externalRequestId: null, externalResourceId: m.id, status: this.normalizeStatus('SENT') };
  }

  async getDeliveryStatus(ctx, request) {
    const m = store.findById(ctx.connection.id, request.externalResourceId);
    if (!m) throw store.erroHttp(404, 'Mensagem não encontrada');
    return { externalRequestId: null, externalResourceId: m.id, status: this.normalizeStatus(m.status) };
  }

  /**
   * Inbound (M9-D235). Com `payload.mode = 'poll'` devolve a página de mensagens recebidas a partir do cursor (leitura periódica, D208); sem isso só confirma o recebimento do payload.
   * O conteúdo da mensagem entra pelo evento `email.received` (webhook assinado) ou por esta leitura, e nos dois casos é interpretado pelo pipeline do domínio, nunca aqui.
   */
  async receiveInbound(ctx, request) {
    const base = { externalRequestId: null, externalResourceId: null, status: this.normalizeStatus('RECEIVED') };
    const p = (request && request.payload) || {};
    if (p.mode !== 'poll') return base;
    return { ...base, ...store.listInbound(ctx.connection.id, p.cursor, p.pageSize) };
  }
}

module.exports = { EmailSandboxAdapter, STATUS };
