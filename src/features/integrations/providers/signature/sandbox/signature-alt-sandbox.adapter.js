'use strict';

const { SignatureSandboxBase } = require('./signature.sandbox.base');
const { signatureEvent, KINDS } = require('./signature.sandbox.event');
const { hmacSha256Base64 } = require('../../../registry/webhookVerifiers');
const { texto } = require('../../../registry/webhookSchemas');

const STATUS = Object.freeze({ WAITING: 'PENDING', SIGNED: 'SIGNER_SIGNED', COMPLETED: 'COMPLETED', VOIDED: 'CANCELED' });
const EXTERNAL = Object.freeze({ PENDING: 'WAITING', COMPLETED: 'COMPLETED', CANCELED: 'VOIDED' });
const TYPES = Object.freeze({ 'party.signed': KINDS.SIGNER_SIGNED, 'doc.completed': KINDS.ENVELOPE_COMPLETED, 'doc.voided': KINDS.ENVELOPE_CANCELLED });

const SCHEMA = Object.freeze({
  type: 'object',
  required: ['event_id', 'event_type', 'document'],
  properties: {
    event_id: texto(160),
    event_type: { type: 'string', enum: Object.keys(TYPES) },
    api_version: texto(16),
    document: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: texto(160), state: texto(32), original_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    party: { type: 'object', additionalProperties: false, properties: { uid: texto(160), mail: texto(254), name: texto(200) } },
    evidence: { type: 'object', additionalProperties: false, properties: { at: { type: 'integer' }, remote_ip: texto(64), ua: texto(300), auth: texto(40) } },
  },
});

/**
 * signature-alt-sandbox (M9-D236): o segundo fornecedor de assinatura de laboratório, que prova a troca de provider (livro, "provider swap preserva contrato interno").
 * Formato B de webhook: `event_id`/`event_type`, `document.ref/state/original_hash`, `party.uid/mail`, `evidence.at` em segundos, estados WAITING/COMPLETED/VOIDED e HMAC-SHA256
 * em base64 no cabeçalho `x-alt-signature` (sem horário assinado). O evento interno normalizado que sai daqui é igual ao do `signature-sandbox`.
 */
class SignatureAltSandboxAdapter extends SignatureSandboxBase {
  providerCode() { return 'signature-alt-sandbox'; }

  idPrefix() { return 'alt'; }

  externalStatusOf(internal) { return EXTERNAL[internal]; }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  webhookVerifier() { return hmacSha256Base64({ header: 'x-alt-signature' }); }

  webhookSchemas() { return { '*': { v1: SCHEMA } }; }

  webhookApiVersion() { return null; }

  toInternalEvent(payload) {
    const kind = TYPES[payload.event_type];
    const e = payload.evidence || {};
    const p = payload.party || {};
    return signatureEvent({
      kind, envelopeId: payload.document.ref, signerId: p.uid, signerEmail: p.mail, signerName: p.name,
      signedAt: Number.isInteger(e.at) ? new Date(e.at * 1000).toISOString() : null, ip: e.remote_ip, userAgent: e.ua, authMethod: e.auth, originalSha256: payload.document.original_hash,
    });
  }
}

module.exports = { SignatureAltSandboxAdapter };
