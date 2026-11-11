'use strict';

const { File, Person, UserMembership, Contract, Property } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Validação de entrada do Jurídico (pentest automatizado M5, 11/2026): todo id que chega no corpo é conferido ANTES de
 * qualquer consulta — formato (UUID em texto; objeto como {"$gt":""} vira 400, nunca 500) e pertencimento à empresa do
 * registro (usuário com vínculo ATIVO na empresa; arquivo, pessoa, contrato e imóvel visíveis sob o RLS e da mesma
 * empresa). A FK do banco não basta: ela não enxerga RLS e aceitaria o id de outra empresa.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isBlank = (value) => value === undefined || value === null || value === '';

function requireUuid(value, field, code) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`"${field}" deve ser um identificador (UUID) em texto.`, code);
  }
  return value.toLowerCase();
}

const optionalUuid = (value, field, code) => (isBlank(value) ? null : requireUuid(value, field, code));

/** Texto opcional: string (aparada) ou null; qualquer outro tipo é 400. */
function optionalString(value, field, code, max = 10000) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw AppError.badRequest(`"${field}" deve ser um texto.`, code);
  const text = value.trim();
  if (text.length > max) throw AppError.badRequest(`"${field}" aceita no máximo ${max} caracteres.`, code);
  return text || null;
}

async function assertUserInCompany(value, { groupId, companyId }, field, code, transaction) {
  const userId = optionalUuid(value, field, code);
  if (!userId) return null;
  const membership = await UserMembership.findOne({ where: { userId, groupId, companyId, status: 'ACTIVE' }, transaction });
  if (!membership) throw AppError.unprocessable(`"${field}": o usuário informado não tem vínculo ativo com esta empresa.`, code);
  return userId;
}

async function assertFileInCompany(value, companyId, field, code, transaction) {
  const fileId = optionalUuid(value, field, code);
  if (!fileId) return null;
  const file = await File.findOne({ where: { id: fileId, companyId }, attributes: ['id'], transaction });
  if (!file) throw AppError.badRequest(`"${field}": o arquivo informado não existe nesta empresa.`, code);
  return fileId;
}

async function assertPersonInCompany(value, companyId, field, code, transaction) {
  const personId = optionalUuid(value, field, code);
  if (!personId) return null;
  const person = await Person.findOne({ where: { id: personId, companyId }, attributes: ['id'], transaction });
  if (!person) throw AppError.badRequest(`"${field}": a pessoa informada não existe nesta empresa.`, code);
  return personId;
}

async function assertContractInCompany(value, companyId, field, code, transaction) {
  const contractId = optionalUuid(value, field, code);
  if (!contractId) return null;
  if (!(await Contract.findOne({ where: { id: contractId, companyId }, attributes: ['id'], transaction }))) {
    throw AppError.badRequest(`"${field}": o contrato informado não existe nesta empresa.`, code);
  }
  return contractId;
}

async function assertPropertyInCompany(value, companyId, field, code, transaction) {
  const propertyId = optionalUuid(value, field, code);
  if (!propertyId) return null;
  if (!(await Property.findOne({ where: { id: propertyId, companyId }, attributes: ['id'], transaction }))) {
    throw AppError.badRequest(`"${field}": o imóvel informado não existe nesta empresa.`, code);
  }
  return propertyId;
}

module.exports = { UUID_RE, isBlank, requireUuid, optionalUuid, optionalString, assertUserInCompany, assertFileInCompany, assertPersonInCompany, assertContractInCompany, assertPropertyInCompany };
