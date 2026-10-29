'use strict';

const crypto = require('crypto');
const { MessagingAdapter } = require('../messaging.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');

const STATUS = Object.freeze({ QUEUED: 'QUEUED', SENT: 'SENT', DELIVERED: 'DELIVERED', READ: 'READ', FAILED: 'FAILED' });

/** Identificador determinístico: o mesmo pedido gera sempre o mesmo id simulado (sem relógio e sem sorteio). */
const idSimulado = (...partes) => `sbx-msg-${crypto.createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 16)}`;

/**
 * messaging-sandbox (M9-D210 3.1): mensageria simulada, sem rede. Serve ao desenvolvimento, aos testes de contrato e ao
 * ambiente SANDBOX; o WhatsApp real entra como outro adapter (M9-D229) sem tocar o domínio.
 */
class MessagingSandboxAdapter extends MessagingAdapter {
  providerCode() { return 'messaging-sandbox'; }

  capabilities() { return ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']; }

  supportedVersions() { return ['v1']; }

  /** Webhook do sandbox: HMAC-SHA256 com horário assinado (cabeçalho x-signature: t=...,v1=...), M9-D211 3.3. */
  webhookVerifier() { return hmacWithTimestamp(); }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async sendText(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado('text', request.to, request.text), status: STATUS.SENT };
  }

  async sendTemplate(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado('template', request.to, request.templateName), status: STATUS.SENT };
  }

  async sendMedia(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado('media', request.to, request.mediaRef), status: STATUS.SENT };
  }

  async getStatus(_ctx, request) {
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: STATUS.DELIVERED };
  }
}

module.exports = { MessagingSandboxAdapter, STATUS };
