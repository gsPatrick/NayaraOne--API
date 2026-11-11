'use strict';

const { ContractVersion } = require('../../models');
const AppError = require('../../utils/AppError');
const { getContract, transitionContractStatus } = require('./contracts.service');
const { getContractVersion } = require('./contractVersions.service');
const { markVersionApproved, assertApprovedCurrentVersion } = require('./contractVersionApproval');
const { assertRequirementsSatisfied } = require('./requirements.service');
const { publishCadernoEvent } = require('./legalEvents.service');
const { initiateSignature } = require('./signatures.service');
const { assertUuidList } = require('./legalIds');

/**
 * Ações sobre uma versão do contrato pelas rotas literais do Guia §14 (Marco 5):
 *  - POST /contract-versions/:id/approve        -> approveContractVersion
 *  - POST /contract-versions/:id/send-signature -> sendContractVersionForSignature
 *
 * Usam a MESMA máquina de estados e os MESMOS gates de transitionContractStatus (checklist
 * documental, documento anexado, auditoria e eventos contract.version.approved /
 * contract.sent_for_signature). O que acrescentam é amarrar a ação à versão informada: só a
 * versão vigente (a mais recente) do contrato pode ser aprovada ou enviada, e o hash gravado
 * precisa bater com o conteúdo gravado (Guia §6 assertHashMatchesStoredFile).
 */
async function loadCurrentVersion(versionId, transaction) {
  const version = await getContractVersion(versionId, transaction);
  const latest = await ContractVersion.findOne({ where: { contractId: version.contractId }, order: [['version_number', 'DESC']], transaction });
  if (latest && latest.id !== version.id) {
    throw AppError.conflict(
      `A versão ${version.versionNumber} foi substituída pela versão ${latest.versionNumber}: só a versão vigente do contrato pode ser aprovada ou enviada para assinatura.`,
      'LEGAL_CONTRACT_VERSION_SUPERSEDED'
    );
  }
  const contract = await getContract(version.contractId, transaction);
  return { version, contract };
}

/**
 * Guia §6 approveVersion: legal:approve (rota), checklist da etapa LEGAL_APPROVAL, hash conferido contra o arquivo
 * armazenado, versão marcada APPROVED (aprovador/data) e homologada no contrato, evento contract.version.approved.
 * Contrato em LEGAL_REVIEW vai a APPROVED; contrato já APPROVED com versão nova em rascunho (o conteúdo mudou)
 * aprova a versão nova sem nova transição.
 */
async function approveContractVersion(versionId, actorUserId, transaction) {
  const { version, contract } = await loadCurrentVersion(versionId, transaction);
  if (contract.status === 'LEGAL_REVIEW') {
    const approved = await transitionContractStatus(contract, 'APPROVED', actorUserId, transaction);
    return { contract: approved, contractVersionId: version.id, contentHash: version.contentHash };
  }
  if (contract.status === 'APPROVED' && version.status === 'DRAFT') {
    await assertRequirementsSatisfied(contract.id, 'APPROVED', transaction);
    await markVersionApproved(contract, version, actorUserId, transaction);
    contract.updatedBy = actorUserId || null;
    await contract.save({ transaction });
    await publishCadernoEvent('contract.version.approved', 'Contract', contract, { id: contract.id, fromStatus: 'APPROVED', contractVersionId: version.id, contentHash: version.contentHash }, `${contract.lockVersion}-${version.id}`, transaction);
    return { contract, contractVersionId: version.id, contentHash: version.contentHash };
  }
  throw AppError.conflict(
    `A versão ${version.versionNumber} (${version.status}) do contrato em "${contract.status}" não pode ser aprovada.`,
    'LEGAL_CONTRACT_INVALID_TRANSITION'
  );
}

async function sendContractVersionForSignature(versionId, signerPersonIds, actorUserId, transaction) {
  if (!Array.isArray(signerPersonIds) || signerPersonIds.length === 0) {
    throw AppError.badRequest('"signerPersonIds" deve ser uma lista não vazia de person ids.', 'LEGAL_SIGNATURE_VALIDATION');
  }
  assertUuidList(signerPersonIds, 'signerPersonIds');
  const { version, contract } = await loadCurrentVersion(versionId, transaction);
  if (contract.status !== 'APPROVED') {
    throw AppError.conflict(
      `Só se envia para assinatura a versão de um contrato APROVADO (APPROVED); o contrato está em "${contract.status}".`,
      'LEGAL_SIGNATURE_VERSION_NOT_APPROVED'
    );
  }
  await assertApprovedCurrentVersion(contract, version, transaction);
  await transitionContractStatus(contract, 'SIGNING', actorUserId, transaction);
  const signatures = await initiateSignature(version.id, signerPersonIds, actorUserId, transaction);
  return { contract, contractVersionId: version.id, contentHash: version.contentHash, signatures };
}

module.exports = { approveContractVersion, sendContractVersionForSignature };
