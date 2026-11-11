'use strict';

/**
 * Repositório do lançamento financeiro (Guia M4 §2, infrastructure/repositories). Todo acesso a dados que os
 * serviços de lançamento, recebimento e pagamento fazem sobre finance.financial_entries e os cadastros que eles
 * conferem (arquivo do comprovante, titular e partes do contrato). Cada função recebe a transação; as consultas
 * e travas são as mesmas que estavam nos serviços.
 */
const { Op } = require('sequelize');
const AppError = require('../../../../utils/AppError');
const { FinancialEntry, File, Person, ContractParty, Project, sequelize } = require('../../../../models');

const forUpdate = (transaction) => (transaction ? transaction.LOCK.UPDATE : undefined);

function findById(id, transaction) {
  return FinancialEntry.findByPk(id, { transaction });
}

/** Lock pessimista na linha do lançamento (serializa baixa, estorno, comprovante e intenção). */
function findByIdForUpdate(id, transaction) {
  return FinancialEntry.findByPk(id, { transaction, lock: forUpdate(transaction) });
}

/** Lançamento da mesma empresa, com lock (origem da caução, dívida compensada). */
function findInCompanyForUpdate(id, companyId, transaction) {
  return FinancialEntry.findOne({ where: { id, companyId }, transaction, lock: forUpdate(transaction) });
}

function create(values, transaction) {
  return FinancialEntry.create(values, { transaction });
}

function save(entry, transaction) {
  return entry.save({ transaction });
}

function list(where, transaction) {
  return FinancialEntry.findAll({ where, order: [['due_at', 'ASC']], transaction });
}

/** Saídas ativas (devolução/compensação não estornadas nem canceladas) de uma caução de origem. */
function findActiveReleases(originEntryId, transaction) {
  return FinancialEntry.findAll({
    where: {
      thirdPartyOriginEntryId: originEntryId,
      parentEntryId: null,
      status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] },
    },
    transaction,
  });
}

function findOneActiveRelease(originEntryId, transaction) {
  return FinancialEntry.findOne({
    where: { thirdPartyOriginEntryId: originEntryId, parentEntryId: null, status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] } },
    transaction,
  });
}

/** Outro lançamento (fora da própria família de baixas) que já usou um destes arquivos como comprovante. */
function findEvidenceReuse(fileIds, entryId, transaction) {
  return FinancialEntry.findOne({
    where: {
      settlementEvidenceFileId: { [Op.in]: fileIds },
      id: { [Op.ne]: entryId },
      [Op.or]: [{ parentEntryId: null }, { parentEntryId: { [Op.ne]: entryId } }],
    },
    transaction,
  });
}

function findClassificationPendings(where, transaction) {
  return FinancialEntry.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

function findSummariesByIds(ids, transaction) {
  return FinancialEntry.findAll({ where: { id: ids }, attributes: ['id', 'description', 'amount', 'dueAt'], transaction });
}

function findEvidenceFile(fileId, companyId, transaction) {
  return File.findOne({ where: { id: fileId, companyId }, transaction });
}

/** F2 (M45): serializa o uso do mesmo conteúdo (SHA-256) como comprovante dentro da empresa. */
function lockEvidenceContent(companyId, checksumSha256, transaction) {
  return sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', {
    replacements: { k: `settlement-evidence:${companyId}:${checksumSha256}` },
    transaction,
  });
}

function findSameContentFileIds(companyId, checksumSha256, transaction) {
  return File.findAll({ attributes: ['id'], where: { companyId, checksumSha256 }, transaction });
}

function findPerson(personId, transaction) {
  return Person.findByPk(personId, { transaction });
}

function findContractParties(contractId, personId, transaction) {
  return ContractParty.findAll({ where: { contractId, personId }, transaction });
}

/** Lançamento já criado a partir de um evento do outbox (source_event_id único — Caderno Obras §7). */
function findBySourceEventId(sourceEventId, transaction) {
  return FinancialEntry.findOne({ where: { sourceEventId }, transaction });
}

/** Lançamento com a chave de idempotência (contas criadas antes do consumidor de eventos). */
function findByIdempotencyKey(idempotencyKey, companyId, transaction) {
  return FinancialEntry.findOne({ where: { idempotencyKey, companyId }, transaction });
}

/** A obra (dimensão construction_project_id) precisa ser da mesma empresa (verificação do Marco 6: FK ignora RLS). */
async function assertConstructionProjectInCompany(projectId, companyId, transaction) {
  if (await Project.findOne({ where: { id: projectId, companyId }, attributes: ['id'], transaction })) return;
  throw AppError.unprocessable('A obra informada não pertence a esta empresa.', 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY', { field: 'constructionProjectId' });
}

module.exports = {
  /** O modelo, para a checagem genérica de chave duplicada do antifraude (assertNoDuplicatePayment recebe o modelo). */
  model: FinancialEntry,
  findById,
  findByIdForUpdate,
  findInCompanyForUpdate,
  findBySourceEventId,
  findByIdempotencyKey,
  assertConstructionProjectInCompany,
  create,
  save,
  list,
  findActiveReleases,
  findOneActiveRelease,
  findEvidenceReuse,
  findClassificationPendings,
  findSummariesByIds,
  findEvidenceFile,
  lockEvidenceContent,
  findSameContentFileIds,
  findPerson,
  findContractParties,
};
