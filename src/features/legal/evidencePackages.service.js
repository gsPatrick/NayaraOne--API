'use strict';

const crypto = require('crypto');
const { EvidencePackage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishEvidencePackageCreated } = require('./legalEvents.service');
const { getLegalCase } = require('./legalCases.service');

/**
 * computePackageHash — SHA-256 hex do manifest_json serializado de forma determinística
 * (JSON.stringify preserva a ordem de inserção das chaves de cada item; como manifestItems é
 * uma lista de objetos simples montada pelo próprio service — não pelo cliente — a ordem das
 * chaves é sempre a mesma, garantindo hash determinístico para o mesmo conteúdo lógico).
 */
function computePackageHash(manifest) {
  const serialized = JSON.stringify(manifest);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * createEvidencePackage — monta manifest_json a partir de manifestItems (cada item deve ter
 * {type, description, referenceId, hash}), calcula o SHA-256 do manifesto serializado e
 * persiste. EvidencePackage é append-only (model sem updatedAt/paranoid) — não existe
 * updateEvidencePackage nem deleteEvidencePackage propositalmente.
 */
async function createEvidencePackage(legalCaseId, manifestItems, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);

  if (!Array.isArray(manifestItems) || manifestItems.length === 0) {
    throw AppError.badRequest('"manifestItems" deve ser uma lista não vazia de itens de evidência.', 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
  }
  for (const item of manifestItems) {
    if (!item || typeof item !== 'object' || !item.type || !item.description) {
      throw AppError.badRequest('Cada item do manifesto precisa de ao menos "type" e "description".', 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
    }
  }

  const manifest = manifestItems.map((item) => ({
    type: item.type,
    description: item.description,
    referenceId: item.referenceId || null,
    hash: item.hash || null,
  }));
  const packageHash = computePackageHash(manifest);

  const evidencePackage = await EvidencePackage.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      manifestJson: manifest,
      packageHash,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await publishEvidencePackageCreated(evidencePackage, transaction);

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.evidence_package.create',
      entityType: 'EvidencePackage',
      entityId: evidencePackage.id,
      afterJson: evidencePackage.toJSON(),
      reason: `Pacote de evidências (${manifest.length} itens) criado para o processo ${legalCase.id}, hash ${packageHash}.`,
    },
    transaction
  );

  return evidencePackage;
}

async function listEvidencePackages(legalCaseId, transaction) {
  return EvidencePackage.findAll({ where: { legalCaseId }, order: [['created_at', 'DESC']], transaction });
}

async function getEvidencePackage(id, transaction) {
  const evidencePackage = await EvidencePackage.findByPk(id, { transaction });
  if (!evidencePackage) throw AppError.notFound('Pacote de evidências não encontrado.', 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND');
  return evidencePackage;
}

module.exports = { createEvidencePackage, listEvidencePackages, getEvidencePackage, computePackageHash };
