'use strict';

const { ProjectType } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Tipos de obra (Caderno Obras §9 "Checklist por etapa/tipo de obra"; verificação independente M6-12/M6-86). O livro não
 * lista os tipos: cada empresa cadastra os seus (regra do Patrick — o que o livro não resolve vira configuração;
 * DI-M6V-2). Toda gravação deixa auditoria com antes e depois. Tipo inativo não pode ser escolhido para obra nova.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

function normalizeCode(code) {
  const value = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(value)) {
    throw AppError.badRequest('"code" deve ter de 1 a 40 caracteres (letras, números, "-" ou "_").', 'PROJECT_TYPE_VALIDATION');
  }
  return value;
}

function normalizeName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 120) throw AppError.badRequest('"name" é obrigatório (até 120 caracteres).', 'PROJECT_TYPE_VALIDATION');
  return value;
}

async function createProjectType(payload, actorUserId, transaction) {
  const { groupId, companyId, description } = payload || {};
  const code = normalizeCode(payload && payload.code);
  const name = normalizeName(payload && payload.name);
  const existing = await ProjectType.findOne({ where: { companyId, code }, transaction });
  if (existing) throw AppError.conflict(`Já existe um tipo de obra com o código "${code}".`, 'PROJECT_TYPE_CODE_DUPLICATE');
  const row = await ProjectType.create(
    { groupId, companyId, code, name, description: description ? String(description) : null, active: true, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'construction.project_type.create', entityType: 'ProjectType', entityId: row.id, afterJson: row.toJSON(), reason: `Tipo de obra "${name}" (${code}) cadastrado.` },
    transaction
  );
  return row;
}

function listProjectTypes(transaction, { includeInactive = true } = {}) {
  const where = includeInactive ? {} : { active: true };
  return ProjectType.findAll({ where, order: [['name', 'ASC']], transaction });
}

async function getProjectType(id, transaction) {
  const row = await ProjectType.findByPk(id, { transaction });
  if (!row) throw AppError.notFound('Tipo de obra não encontrado.', 'PROJECT_TYPE_NOT_FOUND');
  return row;
}

async function updateProjectType(id, payload, actorUserId, transaction) {
  const row = await ProjectType.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw AppError.notFound('Tipo de obra não encontrado.', 'PROJECT_TYPE_NOT_FOUND');
  const beforeJson = row.toJSON();
  const { name, description, active } = payload || {};
  if (name !== undefined) row.name = normalizeName(name);
  if (description !== undefined) row.description = description ? String(description) : null;
  if (active !== undefined) {
    if (typeof active !== 'boolean') throw AppError.badRequest('"active" deve ser verdadeiro ou falso.', 'PROJECT_TYPE_VALIDATION');
    row.active = active;
  }
  row.updatedBy = actorUserId || null;
  await row.save({ transaction });
  await registrarAuditoria(
    { groupId: row.groupId, companyId: row.companyId, actorUserId, action: 'construction.project_type.update', entityType: 'ProjectType', entityId: row.id, beforeJson, afterJson: row.toJSON(), reason: `Tipo de obra "${row.name}" alterado.` },
    transaction
  );
  return row;
}

/** Tipo de obra ATIVO da empresa (para obra nova ou troca de tipo). Recusa tipo de outra empresa ou inativo. */
async function assertActiveProjectType(projectTypeId, companyId, transaction) {
  if (projectTypeId === undefined || projectTypeId === null || projectTypeId === '') return null;
  const row = await ProjectType.findOne({ where: { id: projectTypeId, companyId }, transaction });
  if (!row) throw AppError.unprocessable('"projectTypeId": o tipo de obra informado não pertence a esta empresa (ou não existe).', 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY', { field: 'projectTypeId' });
  if (!row.active) throw AppError.unprocessable('O tipo de obra informado está inativo.', 'PROJECT_TYPE_INACTIVE');
  return row.id;
}

module.exports = { createProjectType, listProjectTypes, getProjectType, updateProjectType, assertActiveProjectType };
