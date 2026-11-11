'use strict';

const { File } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Fechamento M5 — gates da entrega de chaves que vêm do livro (Caderno §10, JUR-005, Guia §11):
 *  - checklist da etapa KEY_DELIVERY pelo Motor de Regras (REG-JUR-001; requirements.service
 *    assertRequirementsSatisfied(contractId, 'KEY_DELIVERY')): documentos e exigências previstos para a entrega;
 *  - assinatura do termo de entrega com evidência: a via do termo assinada pelo recebedor (arquivo da empresa,
 *    com o SHA-256 guardado no momento da assinatura).
 */
const LEASE_KEYS_DELIVER = 'lease.keys.deliver';

async function assertKeyDeliveryRequirements(contractId, transaction) {
  const { assertRequirementsSatisfied } = require('./requirements.service');
  try {
    await assertRequirementsSatisfied(contractId, 'KEY_DELIVERY', transaction);
  } catch (err) {
    if (err && (err.code === 'LEGAL_REQUIREMENTS_PENDING' || err.code === 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND')) {
      throw AppError.conflict(
        `Não é possível entregar as chaves: o checklist da entrega ainda tem pendências. ${err.message}`,
        'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING',
        err.details
      );
    }
    throw err;
  }
}

async function resolveTermEvidence(termEvidenceFileId, contract, transaction) {
  if (!termEvidenceFileId) {
    throw AppError.badRequest(
      'Anexe a via do termo de entrega assinada pelo recebedor ("termEvidenceFileId") — a entrega exige a assinatura do termo.',
      'LEGAL_KEY_DELIVERY_TERM_EVIDENCE_REQUIRED'
    );
  }
  const file = /^[0-9a-f-]{36}$/i.test(String(termEvidenceFileId))
    ? await File.findOne({ where: { id: termEvidenceFileId, companyId: contract.companyId }, attributes: ['id', 'checksumSha256'], transaction })
    : null;
  if (!file || !file.checksumSha256) {
    throw AppError.badRequest('A via assinada do termo precisa ser um arquivo enviado ao sistema por esta empresa.', 'LEGAL_KEY_DELIVERY_TERM_EVIDENCE_INVALID');
  }
  return { termEvidenceFileId: file.id, termEvidenceSha256: file.checksumSha256, termSignatureMethod: 'MANUAL_EVIDENCE' };
}

module.exports = { LEASE_KEYS_DELIVER, assertKeyDeliveryRequirements, resolveTermEvidence };
