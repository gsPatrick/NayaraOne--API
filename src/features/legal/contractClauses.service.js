'use strict';

const { ContractClause } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * contractClauses.service — M5-01 (Caderno CURRENT, Marco 5): biblioteca de cláusulas
 * contratuais VERSIONADAS.
 *
 * REGRA CENTRAL — APPEND-ONLY POR VERSÃO: o texto de uma cláusula (`bodyText`) NUNCA é
 * atualizado no lugar. "Editar" uma cláusula é `createClauseVersion`, que insere uma nova
 * linha com o mesmo `code`, `version_number + 1`, e desativa a versão anterior. Motivo: um
 * contrato assinado em 2024 precisa continuar provando qual era o texto exato da cláusula
 * naquela data — se sobrescrevêssemos o texto, essa prova sumiria. Por isso o model não expõe
 * nenhum `updateClause`.
 *
 * `deactivateClause` é a única mutação permitida e altera apenas a flag `is_active` (tirar a
 * cláusula de circulação para novos templates), nunca o conteúdo.
 */

const CLAUSE_CATEGORIES = ['PAYMENT', 'TERMINATION', 'GUARANTEE', 'GENERAL'];

function validateClausePayload({ code, title, bodyText, category }) {
  if (!code || !String(code).trim()) {
    throw AppError.badRequest('O campo "code" é obrigatório.', 'LEGAL_CONTRACT_CLAUSE_VALIDATION');
  }
  if (!title || !String(title).trim()) {
    throw AppError.badRequest('O campo "title" é obrigatório.', 'LEGAL_CONTRACT_CLAUSE_VALIDATION');
  }
  if (!bodyText || !String(bodyText).trim()) {
    throw AppError.badRequest('O campo "bodyText" é obrigatório e não pode ser vazio.', 'LEGAL_CONTRACT_CLAUSE_VALIDATION');
  }
  if (!category || !CLAUSE_CATEGORIES.includes(category)) {
    throw AppError.badRequest(
      `"category" deve ser um de: ${CLAUSE_CATEGORIES.join(', ')}.`,
      'LEGAL_CONTRACT_CLAUSE_VALIDATION'
    );
  }
}

async function createClause(payload, actorUserId, transaction) {
  const { groupId, companyId, code, title, bodyText, category } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'LEGAL_CONTRACT_CLAUSE_VALIDATION');
  }
  validateClausePayload(payload);

  const existing = await ContractClause.findOne({ where: { companyId, code }, transaction });
  if (existing) {
    throw AppError.conflict(
      `Já existe uma cláusula com o código "${code}". Para alterar o texto, crie uma nova VERSÃO (createClauseVersion) — cláusulas são append-only.`,
      'LEGAL_CONTRACT_CLAUSE_DUPLICATE_CODE'
    );
  }

  const clause = await ContractClause.create(
    {
      groupId,
      companyId,
      code,
      title,
      bodyText,
      category,
      versionNumber: 1,
      isActive: true,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.contract_clause.create',
      entityType: 'ContractClause',
      entityId: clause.id,
      afterJson: clause.toJSON(),
      reason: `Cláusula "${code}" (v1) criada na biblioteca contratual.`,
    },
    transaction
  );

  return clause;
}

/**
 * createClauseVersion — cria a PRÓXIMA versão de uma cláusula existente (mesmo `code`),
 * preservando integralmente a linha anterior (que só tem `is_active` virado para false).
 */
async function createClauseVersion(code, payload, actorUserId, transaction) {
  const latest = await getLatestClauseByCode(code, transaction);
  const nextPayload = {
    code: latest.code,
    title: payload.title !== undefined ? payload.title : latest.title,
    bodyText: payload.bodyText,
    category: payload.category !== undefined ? payload.category : latest.category,
  };
  validateClausePayload(nextPayload);

  const newVersion = await ContractClause.create(
    {
      groupId: latest.groupId,
      companyId: latest.companyId,
      code: latest.code,
      title: nextPayload.title,
      bodyText: nextPayload.bodyText,
      category: nextPayload.category,
      versionNumber: latest.versionNumber + 1,
      isActive: true,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  // A versão anterior sai de circulação, mas o REGISTRO continua intacto (texto, versão, data).
  const beforeJson = latest.toJSON();
  latest.isActive = false;
  await latest.save({ transaction });

  await registrarAuditoria(
    {
      groupId: latest.groupId,
      companyId: latest.companyId,
      actorUserId,
      action: 'legal.contract_clause.new_version',
      entityType: 'ContractClause',
      entityId: newVersion.id,
      beforeJson,
      afterJson: newVersion.toJSON(),
      reason: `Nova versão (v${newVersion.versionNumber}) da cláusula "${latest.code}" criada; v${latest.versionNumber} preservada e desativada.`,
    },
    transaction
  );

  return newVersion;
}

async function getClause(id, transaction) {
  const clause = await ContractClause.findByPk(id, { transaction });
  if (!clause) throw AppError.notFound('Cláusula contratual não encontrada.', 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
  return clause;
}

async function getLatestClauseByCode(code, transaction) {
  const clause = await ContractClause.findOne({
    where: { code },
    order: [['version_number', 'DESC']],
    transaction,
  });
  if (!clause) {
    throw AppError.notFound(`Cláusula "${code}" não encontrada.`, 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
  }
  return clause;
}

async function listClauseVersions(code, transaction) {
  return ContractClause.findAll({ where: { code }, order: [['version_number', 'ASC']], transaction });
}

async function listClauses(transaction, filters = {}) {
  const where = {};
  if (filters.category) where.category = String(filters.category).toUpperCase();
  if (filters.isActive !== undefined) where.isActive = filters.isActive;
  if (filters.code) where.code = filters.code;
  return ContractClause.findAll({ where, order: [['code', 'ASC'], ['version_number', 'ASC']], transaction });
}

async function deactivateClause(id, actorUserId, transaction) {
  const clause = await getClause(id, transaction);
  const beforeJson = clause.toJSON();
  clause.isActive = false;
  await clause.save({ transaction });

  await registrarAuditoria(
    {
      groupId: clause.groupId,
      companyId: clause.companyId,
      actorUserId,
      action: 'legal.contract_clause.deactivate',
      entityType: 'ContractClause',
      entityId: clause.id,
      beforeJson,
      afterJson: clause.toJSON(),
      reason: `Cláusula "${clause.code}" v${clause.versionNumber} desativada (texto preservado).`,
    },
    transaction
  );

  return clause;
}

module.exports = {
  createClause,
  createClauseVersion,
  getClause,
  getLatestClauseByCode,
  listClauseVersions,
  listClauses,
  deactivateClause,
  CLAUSE_CATEGORIES,
};
