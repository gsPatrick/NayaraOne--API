'use strict';

const { ContractVersion } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { assertHashMatchesStoredFile } = require('./contractVersionFile');

/**
 * Aprovação POR VERSÃO (Guia §6 approveVersion: permissão, requirements, assertHashMatchesStoredFile,
 * versions.markApproved; Caderno §19 "Enviar para assinatura | Permissão + versão APPROVED").
 * A versão aprovada vira APPROVED (aprovador e data, gatilho do banco só aceita uma vez) e passa a ser
 * legal.contracts.approved_version_id. Versão criada depois disso nasce DRAFT e precisa de nova aprovação.
 */
const latestVersionOf = (contractId, transaction) => ContractVersion.findOne({ where: { contractId }, order: [['version_number', 'DESC']], transaction });

async function markVersionApproved(contract, version, actorUserId, transaction) {
  if (!actorUserId) {
    throw AppError.forbidden('A aprovação da versão exige um aprovador identificado.', 'LEGAL_CONTRACT_VERSION_APPROVER_REQUIRED');
  }
  if (version.status !== 'DRAFT') {
    throw AppError.conflict(`A versão ${version.versionNumber} não está em rascunho (está ${version.status}) e não pode ser aprovada.`, 'LEGAL_CONTRACT_VERSION_NOT_DRAFT');
  }
  await assertHashMatchesStoredFile(version, transaction);
  const beforeJson = { status: version.status, approvedBy: null, approvedAt: null };
  version.status = 'APPROVED';
  version.approvedBy = actorUserId;
  version.approvedAt = new Date();
  version.updatedBy = actorUserId;
  await version.save({ transaction });
  contract.approvedVersionId = version.id;
  await registrarAuditoria({
    groupId: contract.groupId, companyId: contract.companyId, actorUserId, action: 'legal.contract_version.approve', entityType: 'ContractVersion', entityId: version.id,
    beforeJson, afterJson: { status: 'APPROVED', approvedBy: actorUserId, approvedAt: version.approvedAt, contentHash: version.contentHash },
    reason: `Versão ${version.versionNumber} do contrato ${contract.contractNumber || contract.id} aprovada (hash ${version.contentHash}).`,
  }, transaction);
  return version;
}

/** Aprova a versão vigente do contrato (usada pela transição LEGAL_REVIEW -> APPROVED). */
async function approveLatestVersion(contract, actorUserId, transaction) {
  const latest = await latestVersionOf(contract.id, transaction);
  if (!latest) {
    throw AppError.conflict('Não há versão do contrato para aprovar: crie a versão do documento antes da aprovação.', 'LEGAL_CONTRACT_DOCUMENT_GATE');
  }
  if (latest.status === 'APPROVED' && contract.approvedVersionId === latest.id) return latest;
  return markVersionApproved(contract, latest, actorUserId, transaction);
}

/** A versão que vai para assinatura precisa ser a vigente, APPROVED e a homologada do contrato. */
async function assertApprovedCurrentVersion(contract, version, transaction) {
  const latest = version || (await latestVersionOf(contract.id, transaction));
  if (!latest || latest.status !== 'APPROVED' || contract.approvedVersionId !== latest.id) {
    throw AppError.conflict(
      'Só a versão APROVADA vigente do contrato vai para assinatura: aprove a versão atual (POST /contract-versions/:id/approve) antes de enviar.',
      'LEGAL_SIGNATURE_VERSION_NOT_APPROVED'
    );
  }
  return latest;
}

module.exports = { markVersionApproved, approveLatestVersion, assertApprovedCurrentVersion, latestVersionOf };
