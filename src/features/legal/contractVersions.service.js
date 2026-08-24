'use strict';

const crypto = require('crypto');
const { ContractVersion } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishContractVersionCreated } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');

/**
 * ContractVersion é append-only (sem paranoid, sem lock_version — ver model). content_hash é
 * um SHA-256 hex do conteúdo do documento.
 *
 * SIMPLIFICAÇÃO ASSUMIDA (decisão de engenharia): o sistema real ainda não tem storage de
 * arquivo integrado a este fluxo (document_file_id é nullable e aponta pra people.files, que
 * é gerenciado por outra feature). Como não há upload de arquivo real neste marco, o hash é
 * calculado sobre um `content` textual/JSON que o chamador informa representando o conteúdo
 * da versão do contrato (ex.: o corpo do documento renderizado, ou um resumo estruturado dos
 * termos). Em produção, quando a integração de storage estiver pronta, o ideal é hashear os
 * bytes reais do arquivo carregado — aqui hasheamos o payload textual informado.
 */
function computeContentHash(content) {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

async function createContractVersion(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { content, documentFileId, effectiveFrom } = payload;
  if (content === undefined || content === null) {
    throw AppError.badRequest('O campo "content" é obrigatório (texto/JSON do documento usado para calcular o content_hash).', 'LEGAL_CONTRACT_VERSION_VALIDATION');
  }

  const lastVersion = await ContractVersion.findOne({
    where: { contractId: contract.id },
    order: [['version_number', 'DESC']],
    transaction,
  });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const contractVersion = await ContractVersion.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      versionNumber: nextVersionNumber,
      documentFileId: documentFileId || null,
      contentHash: computeContentHash(content),
      effectiveFrom: effectiveFrom || new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishContractVersionCreated(contractVersion, transaction);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_version.create',
      entityType: 'ContractVersion',
      entityId: contractVersion.id,
      afterJson: contractVersion.toJSON(),
      reason: `Versão ${nextVersionNumber} do contrato ${contract.id} criada (imutável).`,
    },
    transaction
  );

  return contractVersion;
}

async function listContractVersions(contractId, transaction) {
  return ContractVersion.findAll({ where: { contractId }, order: [['version_number', 'ASC']], transaction });
}

async function getContractVersion(id, transaction) {
  const version = await ContractVersion.findByPk(id, { transaction });
  if (!version) throw AppError.notFound('Versão de contrato não encontrada.', 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  return version;
}

module.exports = { createContractVersion, listContractVersions, getContractVersion, computeContentHash };
