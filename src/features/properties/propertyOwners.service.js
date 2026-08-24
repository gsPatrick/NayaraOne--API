'use strict';

const { PropertyOwner, Property, Person } = require('../../models');
const AppError = require('../../utils/AppError');

const ROLE_CODES = ['OWNER', 'USUFRUCTUARY'];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createOwner(propertyId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { personId, ownershipPercent, roleCode, validFrom, validUntil } = payload;
  if (!personId) {
    throw AppError.badRequest('O campo "personId" é obrigatório.', 'PROPERTY_OWNER_VALIDATION');
  }
  const normalizedRole = roleCode ? String(roleCode).toUpperCase() : 'OWNER';
  if (!ROLE_CODES.includes(normalizedRole)) {
    throw AppError.badRequest(`O campo "roleCode" deve ser um de: ${ROLE_CODES.join(', ')}.`, 'PROPERTY_OWNER_VALIDATION');
  }
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa (proprietário) não encontrada.', 'PERSON_NOT_FOUND');

  return PropertyOwner.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      personId,
      ownershipPercent: ownershipPercent !== undefined ? ownershipPercent : null,
      roleCode: normalizedRole,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listOwners(propertyId, transaction) {
  await assertPropertyExists(propertyId, transaction);
  return PropertyOwner.findAll({ where: { propertyId }, order: [['created_at', 'DESC']], transaction });
}

async function getOwner(propertyId, ownerId, transaction) {
  const owner = await PropertyOwner.findOne({ where: { id: ownerId, propertyId }, transaction });
  if (!owner) throw AppError.notFound('Proprietário não encontrado.', 'PROPERTY_OWNER_NOT_FOUND');
  return owner;
}

async function updateOwner(propertyId, ownerId, payload, actorUserId, transaction) {
  const owner = await getOwner(propertyId, ownerId, transaction);
  const { ownershipPercent, roleCode, validFrom, validUntil } = payload;
  if (ownershipPercent !== undefined) owner.ownershipPercent = ownershipPercent;
  if (roleCode !== undefined) {
    const normalizedRole = String(roleCode).toUpperCase();
    if (!ROLE_CODES.includes(normalizedRole)) {
      throw AppError.badRequest(`O campo "roleCode" deve ser um de: ${ROLE_CODES.join(', ')}.`, 'PROPERTY_OWNER_VALIDATION');
    }
    owner.roleCode = normalizedRole;
  }
  if (validFrom !== undefined) owner.validFrom = validFrom;
  if (validUntil !== undefined) owner.validUntil = validUntil;
  owner.updatedBy = actorUserId || null;
  await owner.save({ transaction });
  return owner;
}

async function deleteOwner(propertyId, ownerId, actorUserId, transaction) {
  const owner = await getOwner(propertyId, ownerId, transaction);
  owner.deletedBy = actorUserId || null;
  await owner.save({ transaction });
  await owner.destroy({ transaction });
  return { id: ownerId };
}

module.exports = { createOwner, listOwners, getOwner, updateOwner, deleteOwner, ROLE_CODES };
