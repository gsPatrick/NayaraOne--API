'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { PersonRole, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { sessionCompanyId, contextCompanyId } = require('./personView');
const { readRoleCatalog } = require('./personRoles.settings');

// M3-02 / CRMX-002 (DI-M3PE-2): a lista de papéis aceitos é o catálogo configurável da empresa (personRoles.settings.js, parâmetro
// `people.papeis`), com os cinco papéis do livro sempre presentes (cliente, proprietário, vendedor, locatário, fornecedor). Antes era uma
// constante neste arquivo, sem VENDEDOR.

/** Recusa (400 PERSON_ROLE_VALIDATION) o código que não está no catálogo vigente da empresa; devolve o código normalizado. */
async function assertRoleInCatalog(roleCode, tenant, transaction) {
  const normalized = String(roleCode || '').trim().toUpperCase();
  const catalog = await readRoleCatalog(tenant, transaction);
  if (!catalog.some((role) => role.code === normalized)) {
    throw AppError.badRequest(
      `O papel "${normalized || '(vazio)'}" não está no catálogo de papéis desta empresa. Papéis aceitos: ${catalog.map((r) => r.label).join(', ')}.`,
      'PERSON_ROLE_VALIDATION',
      { fields: [{ field: 'roleCode', message: 'Escolha um papel do catálogo.' }], aceitos: catalog.map((r) => r.code) }
    );
  }
  return normalized;
}

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

async function createRole(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const { roleCode, startsAt, endsAt } = payload;
  const companyId = await sessionCompanyId(person, transaction); // DI-M9I-3: o dado é da empresa da sessão (vinculada ou responsável)
  const normalizedRole = await assertRoleInCatalog(roleCode, { groupId: person.groupId, companyId }, transaction);
  return PersonRole.create(
    {
      groupId: person.groupId,
      companyId,
      personId,
      roleCode: normalizedRole,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listRoles(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return PersonRole.findAll({ where: { personId }, order: [['created_at', 'DESC']], transaction });
}

async function getRole(personId, roleId, transaction) {
  const role = await PersonRole.findOne({ where: { id: roleId, personId }, transaction });
  if (!role) throw AppError.notFound('Papel não encontrado.', 'PERSON_ROLE_NOT_FOUND');
  return role;
}

async function updateRole(personId, roleId, payload, actorUserId, transaction) {
  const role = await getRole(personId, roleId, transaction);
  const { startsAt, endsAt } = payload;
  // roleCode faz parte da PK composta (person_id, role_code, company_id) — alterá-lo exigiria
  // recriar a linha (delete + insert), não um UPDATE simples; não suportado nesta operação.
  if (payload.roleCode !== undefined && String(payload.roleCode).toUpperCase() !== role.roleCode) {
    throw AppError.badRequest(
      'O campo "roleCode" não pode ser alterado (é parte da chave primária); remova o papel e crie um novo.',
      'PERSON_ROLE_IMMUTABLE_CODE'
    );
  }
  if (startsAt !== undefined) role.startsAt = startsAt;
  if (endsAt !== undefined) role.endsAt = endsAt;
  role.updatedBy = actorUserId || null;
  await role.save({ transaction });
  return role;
}

async function deleteRole(personId, roleId, actorUserId, transaction) {
  await legalHold.assertNotOnHold('PERSON', personId, transaction); // M9-D912
  const role = await getRole(personId, roleId, transaction);
  role.deletedBy = actorUserId || null;
  await role.save({ transaction });
  await role.destroy({ transaction });
  return { id: roleId };
}

/** Catálogo de papéis da empresa da sessão (GET /people/roles-catalog): a tela de cadastro monta as opções a partir dele. */
async function listRoleCatalog(tenant, transaction) {
  const companyId = (await contextCompanyId(transaction)) || tenant.companyId;
  return readRoleCatalog({ groupId: tenant.groupId, companyId }, transaction);
}

// Nome de antes do M3-02 (lista fixa), mantido para quem já o usava (ex.: teste ISO-8 do Marco 9): os papéis do livro, que estão no catálogo
// padrão da empresa (personRoles.settings DEFAULT_ROLES). A lista que vale para gravar é a do catálogo (assertRoleInCatalog).
const VALID_ROLES = require('./personRoles.settings').BOOK_ROLES;

module.exports = { createRole, listRoles, getRole, updateRole, deleteRole, assertRoleInCatalog, listRoleCatalog, VALID_ROLES };
