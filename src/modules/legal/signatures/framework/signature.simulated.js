'use strict';

const { SignatureEnvelope } = require('../../../../models');
const registry = require('../../../../features/integrations/registry/registry.service');
const { simulatedEvidence } = require('./signature.evidence');

const LAB_PROVIDERS = Object.freeze(['signature-sandbox', 'signature-alt-sandbox']);

/**
 * Assinatura confirmada pelo fluxo interno do sandbox (`handleSignatureWebhook` sem evento do fornecedor: testes, desenvolvimento, o webhook autenticado de laboratório):
 * fora de produção e só para o fornecedor de laboratório, a evidência é gravada como SIMULADA e completa. Fornecedor real nunca ganha evidência por aqui: a dele vem do
 * evento assinado (signature.events.js), e sem ela o portão da evidência segura o contrato.
 */
async function recordSimulatedEvidence(signature, payload, transaction) {
  if ((payload && payload.providerEvent) || signature.signatureMethod === 'MANUAL' || signature.evidenceComplete || !signature.envelopeId) return;
  if (registry.getServerEnvironment() === 'PRODUCTION') return;
  const envelope = await SignatureEnvelope.findByPk(signature.envelopeId, { transaction });
  if (!envelope || !LAB_PROVIDERS.includes(envelope.providerCode)) return;
  await signature.update({ evidenceJson: simulatedEvidence(envelope), evidenceComplete: true }, { transaction });
}

module.exports = { recordSimulatedEvidence, LAB_PROVIDERS };
