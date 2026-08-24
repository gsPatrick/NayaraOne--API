'use strict';

const { PersonRole, Person } = require('../../models');
const AppError = require('../../utils/AppError');

// Valores confirmados pelo Caderno (citação literal, lista aberta/não exaustiva): CLIENTE,
// PROPRIETARIO, LOCATARIO, FORNECEDOR — mais CORRETOR, já usado no mock do frontend.
const VALID_ROLES = ['CLIENTE', 'PROPRIETARIO', 'LOCATARIO', 'FORNECEDOR', 'CORRETOR'];

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

async function createRole(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const { roleCode, startsAt, endsAt } = payload;
  const normalizedRole = String(roleCode || '').toUpperCase();
  if (!VALID_ROLES.includes(normalizedRole)) {
    throw AppError.badRequest(
      `O campo "roleCode" deve ser um de: ${VALID_ROLES.join(', ')}.`,
      'PERSON_ROLE_VALIDATION'
    );
  }
  return PersonRole.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
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
  const role = await getRole(personId, roleId, transaction);
  role.deletedBy = actorUserId || null;
  await role.save({ transaction });
  await role.destroy({ transaction });
  return { id: roleId };
}

module.exports = { createRole, listRoles, getRole, updateRole, deleteRole, VALID_ROLES };
