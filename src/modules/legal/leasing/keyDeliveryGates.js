'use strict';

const { Op } = require('sequelize');
const { File, Contract, ContractRequirement } = require('../../../models');
const AppError = require('../../../utils/AppError');

/**
 * Fechamento M5 — gates da entrega de chaves que vêm do livro (Caderno §10, JUR-005, Guia §11):
 *  - checklist da etapa KEY_DELIVERY pelo Motor de Regras (REG-JUR-001; requirements.service
 *    assertRequirementsSatisfied(contractId, 'KEY_DELIVERY')): documentos e exigências previstos para a entrega;
 *  - assinatura do termo de entrega com evidência: a via do termo assinada pelo recebedor (arquivo da empresa,
 *    com o SHA-256 guardado no momento da assinatura).
 */
const LEASE_KEYS_DELIVER = 'lease.keys.deliver';

const TERM_CONTRACT_TYPES = ['KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];
const CLOSED_STATUSES = ['TERMINATED', 'CLOSED'];

function pendingError(err) {
  return AppError.conflict(
    `Não é possível entregar as chaves: o checklist da entrega ainda tem pendências. ${err.message}`,
    'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING',
    err.details
  );
}

/**
 * Fechamento M5 (M5-A0079): as exigências da etapa KEY_DELIVERY da política vigente (Motor de Regras) entram no checklist do
 * contrato na hora da entrega — inclusive em contrato cujo checklist foi gerado antes de a política ter o item (só o que
 * falta é criado; o resto não muda).
 */
async function syncKeyDeliveryStageItems(contract, transaction) {
  const { resolveRequirementItems } = require('../contracts/application/requirementRules.service');
  const { generateRequirementsForContract } = require('../contracts/application/requirement.service');
  const existing = await ContractRequirement.findAll({ where: { contractId: contract.id }, attributes: ['requirementCode'], transaction });
  if (!existing.length) return; // sem checklist ainda: assertRequirementsSatisfied gera o checklist inteiro
  // Assinatura da verificação M5 linha 65 (contratos): (contrato, ator, transação) — quem chama não escolhe o modelo do checklist.
  const { items } = await resolveRequirementItems(contract, null, transaction);
  const have = new Set(existing.map((r) => r.requirementCode));
  if ((items || []).some((i) => i.stage === 'KEY_DELIVERY' && !have.has(i.requirementCode))) {
    await generateRequirementsForContract(contract.id, {}, null, transaction);
  }
}

async function assertKeyDeliveryRequirements(contractId, transaction) {
  const { assertRequirementsSatisfied } = require('../contracts/application/requirement.service');
  const contract = await Contract.findByPk(contractId, { transaction });
  try {
    if (contract) await syncKeyDeliveryStageItems(contract, transaction);
    await assertRequirementsSatisfied(contractId, 'KEY_DELIVERY', transaction);
    // Livro §7 "Entrega de casa nova: termo, vistoria final, manual do proprietário, fotos, chaves" e "Imóvel usado: termo
    // específico": o checklist do termo de entrega vinculado ao contrato (KEY_DELIVERY/USED_PROPERTY_DELIVERY) também precisa
    // estar completo para a entrega do contrato principal.
    const terms = await Contract.findAll({
      where: { parentContractId: contractId, contractType: TERM_CONTRACT_TYPES, status: { [Op.notIn]: CLOSED_STATUSES } },
      attributes: ['id', 'contractType'],
      transaction,
    });
    for (const term of terms) await assertRequirementsSatisfied(term.id, transaction);
  } catch (err) {
    if (err && (err.code === 'LEGAL_REQUIREMENTS_PENDING' || err.code === 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND')) throw pendingError(err);
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
