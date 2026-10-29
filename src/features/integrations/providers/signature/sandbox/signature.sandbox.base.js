'use strict';

const crypto = require('node:crypto');
const { SignatureAdapter } = require('../signature.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const store = require('./signature.sandbox.store');

/**
 * Base dos adapters de assinatura de laboratório (M9-D236 3.2 item 6): o mesmo comportamento de envelope, signatário e arquivo assinado, em dois formatos de webhook
 * diferentes (`signature-sandbox` e `signature-alt-sandbox`). Quem herda declara só o que muda entre fornecedores: o código, a tabela de status, o verificador do webhook,
 * os esquemas dos eventos e a conversão do evento do fornecedor para o evento interno normalizado. A suíte de troca de fornecedor (M9-D221) prova que o resultado interno é o mesmo.
 */
const ENVELOPE_STATUS = Object.freeze({ PENDING: 'PENDING', COMPLETED: 'COMPLETED', CANCELED: 'CANCELED' });

class SignatureSandboxBase extends SignatureAdapter {
  /** Prefixo dos ids simulados (cada formato tem o seu). */
  idPrefix() { throw new Error('idPrefix() não implementado'); }

  /** Status externo do envelope -> texto no vocabulário do fornecedor (usado em getEnvelope/cancelEnvelope). */
  externalStatusOf(_internal) { throw new Error('externalStatusOf() não implementado'); }

  capabilities() { return ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook']; }

  supportedVersions() { return ['v1']; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  supportsIdempotency(operation) { return operation === 'createEnvelope'; }

  statusRank() { return { PENDING: 1, CANCELED: 2, COMPLETED: 3 }; }

  async createEnvelope(ctx, request, meta) {
    const chave = (meta && meta.idempotencyKey) || crypto.createHash('sha256').update([String(request.documentRef), String(request.documentSha256), ...store.normalizeSigners(request.signers).map((s) => String(s.personId ?? s.email))].join('|')).digest('hex');
    const envelope = store.createEnvelope(ctx.connection.id, chave, request, this.idPrefix());
    if (store.injectFault(ctx, envelope.id)) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    // `signers` não faz parte da saída normalizada: é o que o domínio de assinatura lê da resposta bruta para ligar cada pessoa ao seu id no fornecedor.
    return {
      externalRequestId: null, externalResourceId: envelope.id, status: this.normalizeStatus(this.externalStatusOf(envelope.status)),
      signers: envelope.signers.map((s) => ({ personId: s.personId, externalSignerId: s.externalSignerId, email: s.email })),
    };
  }

  async getEnvelope(ctx, request) {
    const envelope = store.findById(ctx.connection.id, request.externalResourceId);
    if (!envelope) throw store.erroHttp(404, 'Envelope não encontrado');
    return { externalRequestId: null, externalResourceId: envelope.id, status: this.normalizeStatus(this.externalStatusOf(envelope.status)) };
  }

  async cancelEnvelope(ctx, request) {
    const envelope = store.findById(ctx.connection.id, request.externalResourceId);
    if (!envelope) throw store.erroHttp(404, 'Envelope não encontrado');
    if (envelope.status === ENVELOPE_STATUS.PENDING) envelope.status = ENVELOPE_STATUS.CANCELED;
    return { externalRequestId: null, externalResourceId: envelope.id, status: this.normalizeStatus(this.externalStatusOf(envelope.status)) };
  }

  /** Arquivo assinado: `document` leva os bytes (o domínio os guarda e calcula o hash); o resto da resposta é a saída normalizada. */
  async downloadSigned(ctx, request) {
    const envelope = store.findById(ctx.connection.id, request.externalResourceId);
    const original = request.documentSha256 || (envelope && envelope.documentSha256) || null;
    return {
      externalRequestId: null, externalResourceId: request.externalResourceId, status: this.normalizeStatus(this.externalStatusOf(ENVELOPE_STATUS.COMPLETED)),
      document: { buffer: store.signedDocument(request.externalResourceId, original), fileName: `${request.externalResourceId}-assinado.txt` },
    };
  }

  async verifyWebhook(_ctx, request) {
    const verificador = this.webhookVerifier();
    const r = verificador.verify({ rawBody: request.rawBody, headers: request.headers || {}, secret: request.secret, now: new Date() });
    return { externalRequestId: null, externalResourceId: null, status: r.ok ? 'VALID' : 'INVALID' };
  }

  async findByIdempotencyKey(ctx, request) {
    const envelope = store.findByKey(ctx.connection.id, request.idempotencyKey);
    return envelope ? { found: true, externalResourceId: envelope.id, status: this.externalStatusOf(envelope.status) } : { found: false };
  }

  async findByReference(ctx, request) {
    const envelope = request.documentRef ? store.findByDocument(ctx.connection.id, request.documentRef) : null;
    return envelope ? { found: true, externalResourceId: envelope.id, status: this.externalStatusOf(envelope.status) } : { found: false };
  }
}

module.exports = { SignatureSandboxBase, ENVELOPE_STATUS };
