'use strict';

const { SignatureSandboxBase } = require('./signature.sandbox.base');
const { signatureEvent, KINDS } = require('./signature.sandbox.event');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { texto } = require('../../../registry/webhookSchemas');

const STATUS = Object.freeze({ PENDING: 'PENDING', SIGNED: 'SIGNER_SIGNED', COMPLETED: 'COMPLETED', CANCELED: 'CANCELED', CANCELLED: 'CANCELED' });
const EXTERNAL = Object.freeze({ PENDING: 'pending', COMPLETED: 'completed', CANCELED: 'cancelled' });
const TYPES = Object.freeze({ 'signer.signed': KINDS.SIGNER_SIGNED, 'envelope.completed': KINDS.ENVELOPE_COMPLETED, 'envelope.cancelled': KINDS.ENVELOPE_CANCELLED });
const SHA = { type: 'string', pattern: '^[0-9a-f]{64}$' };

const SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'envelope'],
  properties: {
    id: texto(160),
    type: { type: 'string', enum: Object.keys(TYPES) },
    api_version: texto(16),
    envelope: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: texto(160), status: texto(32) } },
    signer: { type: 'object', additionalProperties: false, properties: { id: texto(160), email: texto(254), name: texto(200) } },
    signedAt: texto(40),
    evidence: { type: 'object', additionalProperties: false, properties: { ip: texto(64), userAgent: texto(300), authMethod: texto(40) } },
    documentSha256: SHA,
  },
});

/**
 * signature-sandbox (M9-D236): assinatura simulada, sem rede, no formato A de webhook (JSON com `type` pontuado, `envelope`, `signer`, `evidence` e `documentSha256` do
 * conteúdo original; HMAC-SHA256 com horário assinado em `x-signature`). O `signature-alt-sandbox` fala o mesmo com outro formato e outros códigos.
 */
class SignatureSandboxAdapter extends SignatureSandboxBase {
  providerCode() { return 'signature-sandbox'; }

  idPrefix() { return 'sbx'; }

  externalStatusOf(internal) { return EXTERNAL[internal]; }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  webhookVerifier() { return hmacWithTimestamp(); }

  webhookSchemas() { return { '*': { v1: SCHEMA } }; }

  toInternalEvent(payload) {
    const kind = TYPES[payload.type];
    const e = payload.evidence || {};
    return signatureEvent({
      kind, envelopeId: payload.envelope.id, signerId: payload.signer && payload.signer.id, signerEmail: payload.signer && payload.signer.email, signerName: payload.signer && payload.signer.name,
      signedAt: payload.signedAt, ip: e.ip, userAgent: e.userAgent, authMethod: e.authMethod, originalSha256: payload.documentSha256,
    });
  }
}

module.exports = { SignatureSandboxAdapter };
