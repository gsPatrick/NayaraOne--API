'use strict';

const { Op, QueryTypes } = require('sequelize');
const { Unit, Property, Person, Project, ProjectStage, InventoryLocation, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { findCompanyUser } = require('../core-governance/governance.users');

/**
 * Referências de Obras sempre da MESMA empresa (verificação independente do Marco 6: M6-95, M6-104 e varredura de todos
 * os serviços de Obras). Chave estrangeira no PostgreSQL ignora RLS: sem esta conferência, uma unidade, imóvel,
 * prestador, obra ou local de estoque de OUTRA empresa era gravado. Cada função consulta a linha filtrando por
 * company_id, dentro da transação do tenant (RLS também vale), e recusa com 422 CONSTRUCTION_REFERENCE_NOT_IN_COMPANY
 * — nada é gravado. Usuário (core.users é global) precisa ter vínculo ATIVO com a empresa e estar ATIVO.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = 'CONSTRUCTION_REFERENCE_NOT_IN_COMPANY';

function recusar(field, what) {
  return AppError.unprocessable(`"${field}": ${what} não pertence a esta empresa (ou não existe).`, CODE, { field });
}

function idOuNulo(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value).trim();
  if (!UUID_RE.test(id)) throw AppError.badRequest(`"${field}" deve ser um identificador válido.`, 'INVALID_ID_FORMAT', { field });
  return id;
}

async function assertRow(Model, value, companyId, field, what, transaction, extraWhere = {}) {
  const id = idOuNulo(value, field);
  if (!id) return null;
  const row = await Model.findOne({ where: { id, companyId, ...extraWhere }, attributes: ['id'], transaction });
  if (!row) throw recusar(field, what);
  return id;
}

const assertUnitInCompany = (v, companyId, t, field = 'unitId') => assertRow(Unit, v, companyId, field, 'a unidade informada', t);
const assertPropertyInCompany = (v, companyId, t, field = 'propertyId') => assertRow(Property, v, companyId, field, 'o imóvel informado', t);
const assertPersonInCompany = (v, companyId, t, field = 'personId') => assertRow(Person, v, companyId, field, 'a pessoa informada', t);
const assertProjectInCompany = (v, companyId, t, field = 'projectId') => assertRow(Project, v, companyId, field, 'a obra informada', t);
/** Obra do parâmetro da rota: de outra empresa (ou inexistente) é 404, como toda leitura de obra sob RLS (ADV-OBR-1). */
async function assertRouteProjectInCompany(projectId, companyId, transaction) {
  const id = idOuNulo(projectId, 'projectId');
  if (!id || !(await Project.findOne({ where: { id, companyId }, attributes: ['id'], transaction }))) {
    throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  }
  return id;
}
const assertLocationInCompany = (v, companyId, t, field = 'locationId') => assertRow(InventoryLocation, v, companyId, field, 'o local de estoque informado', t);

/** Etapa da MESMA obra (e, por consequência, da mesma empresa). */
async function assertStageInProject(value, projectId, companyId, transaction, field = 'projectStageId') {
  return assertRow(ProjectStage, value, companyId, field, 'a etapa informada (desta obra)', transaction, { projectId });
}

/** Todas as pessoas de uma lista (prestadores do RDO) precisam ser da empresa. */
async function assertPersonsInCompany(ids, companyId, transaction, field = 'workers[].personId') {
  const unique = [...new Set((ids || []).map((v) => idOuNulo(v, field)).filter(Boolean))];
  if (!unique.length) return;
  const found = await Person.findAll({ where: { id: { [Op.in]: unique }, companyId }, attributes: ['id'], transaction });
  if (found.length !== unique.length) throw recusar(field, 'o prestador/fornecedor informado');
}

/** Usuário membro ATIVO da empresa (vínculo ativo e usuário ativo). */
async function assertActiveMember(value, companyId, transaction, field = 'responsibleUserId') {
  const id = idOuNulo(value, field);
  if (!id) return null;
  const user = await findCompanyUser(id, { companyId }, transaction);
  if (!user.exists || !user.active) throw recusar(field, 'o usuário informado (membro ativo)');
  return id;
}

/** Membros ATIVOS da empresa (para os campos de responsável das telas de Obras): só quem a conferência aceita. */
function listActiveMembers(companyId, transaction) {
  return sequelize.query(
    `SELECT DISTINCT u.id, u.name FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
      WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
      ORDER BY u.name`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId } }
  );
}

module.exports = {
  CODE,
  listActiveMembers,
  assertUnitInCompany,
  assertPropertyInCompany,
  assertPersonInCompany,
  assertPersonsInCompany,
  assertProjectInCompany,
  assertRouteProjectInCompany,
  assertStageInProject,
  assertLocationInCompany,
  assertActiveMember,
};
