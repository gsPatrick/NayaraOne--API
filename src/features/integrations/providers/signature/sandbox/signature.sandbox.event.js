'use strict';

/**
 * Evento interno normalizado de assinatura (M9-D236 3.2 item 6): igual para qualquer fornecedor. `data` é o que vai ao outbox (só ids e o tipo do fato);
 * `private` é o que só o tratador do Jurídico lê, na mesma transação (e-mail do signatário, horário, IP, user-agent, método, hash do original) e que nunca vai ao outbox.
 * kind: SIGNER_SIGNED (um signatário assinou), ENVELOPE_COMPLETED (todas as assinaturas feitas) ou ENVELOPE_CANCELLED.
 */
const KINDS = Object.freeze({ SIGNER_SIGNED: 'SIGNER_SIGNED', ENVELOPE_COMPLETED: 'ENVELOPE_COMPLETED', ENVELOPE_CANCELLED: 'ENVELOPE_CANCELLED' });

const STATUS_BY_KIND = Object.freeze({ SIGNER_SIGNED: 'SIGNED', ENVELOPE_COMPLETED: 'COMPLETED', ENVELOPE_CANCELLED: 'CANCELED' });

function signatureEvent({ kind, envelopeId, signerId = null, signerEmail = null, signerName = null, signedAt = null, ip = null, userAgent = null, authMethod = null, originalSha256 = null }) {
  return {
    eventType: 'integration.signature.event',
    resourceRef: envelopeId,
    externalStatus: STATUS_BY_KIND[kind],
    idempotencyKey: null,
    data: { kind, externalEnvelopeId: envelopeId, externalSignerId: signerId },
    private: { signerEmail, signerName, signedAt, evidence: { ip, userAgent, authMethod }, originalSha256 },
  };
}

module.exports = { signatureEvent, KINDS };
