'use strict';

const { Property, PropertyOwner, PropertyOffer, PropertyAddress } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishPropertyCreated } = require('./propertyEvents.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const PROPERTY_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'LAND', 'RURAL'];
const PUBLICATION_STATUSES = ['DRAFT', 'READY', 'PUBLISHED', 'INACTIVE'];
const AVAILABILITY_STATUSES = ['AVAILABLE', 'SOLD', 'RENTED', 'WITHDRAWN'];

async function createOrReuseAddress(addressPayload, transaction) {
  if (!addressPayload) return null;
  const { zipCode, street, number, complement, neighborhood, city, state } = addressPayload;
  if (!zipCode || !street || !neighborhood || !city || !state) {
    throw AppError.badRequest(
      'O endereço requer "zipCode", "street", "neighborhood", "city" e "state".',
      'PROPERTY_ADDRESS_VALIDATION'
    );
  }
  const address = await PropertyAddress.create(
    { zipCode, street, number: number || null, complement: complement || null, neighborhood, city, state },
    { transaction }
  );
  return address.id;
}

async function createProperty(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    title,
    internalCode,
    propertyType,
    address,
    addressId,
    registryNumber,
    registryOffice,
    latitude,
    longitude,
    publicationStatus,
    availabilityStatus,
    // Colunas legadas de endereço "achatado" (ainda existentes na tabela — ver comentário em
    // src/models/Property.js) — mantidas por compatibilidade com o matching de radar, que hoje
    // filtra diretamente por city/state/areaTotalM2 em Property.
    addressLine,
    city,
    state,
    zipCode,
    areaTotalM2,
  } = payload;
  if (!groupId || !companyId || !title || !internalCode || !propertyType) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "title", "internalCode" e "propertyType" são obrigatórios.',
      'PROPERTY_VALIDATION'
    );
  }
  const normalizedType = String(propertyType).toUpperCase();
  if (!PROPERTY_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "propertyType" deve ser um de: ${PROPERTY_TYPES.join(', ')}.`, 'PROPERTY_VALIDATION');
  }
  if (publicationStatus && !PUBLICATION_STATUSES.includes(String(publicationStatus).toUpperCase())) {
    throw AppError.badRequest(`O campo "publicationStatus" deve ser um de: ${PUBLICATION_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
  }
  if (availabilityStatus && !AVAILABILITY_STATUSES.includes(String(availabilityStatus).toUpperCase())) {
    throw AppError.badRequest(`O campo "availabilityStatus" deve ser um de: ${AVAILABILITY_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
  }

  const resolvedAddressId = addressId || (await createOrReuseAddress(address, transaction));

  const property = await Property.create(
    {
      groupId,
      companyId,
      title,
      internalCode,
      propertyType: normalizedType,
      addressId: resolvedAddressId || null,
      registryNumber: registryNumber || null,
      registryOffice: registryOffice || null,
      latitude: latitude !== undefined ? latitude : null,
      longitude: longitude !== undefined ? longitude : null,
      addressLine: addressLine || null,
      city: city || null,
      state: state || null,
      zipCode: zipCode || null,
      areaTotalM2: areaTotalM2 || null,
      publicationStatus: publicationStatus ? String(publicationStatus).toUpperCase() : 'DRAFT',
      availabilityStatus: availabilityStatus ? String(availabilityStatus).toUpperCase() : 'AVAILABLE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishPropertyCreated(property, transaction);

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property.create',
      entityType: 'Property',
      entityId: property.id,
      afterJson: property.toJSON(),
      reason: `Imóvel "${property.title}" (${property.internalCode}) cadastrado.`,
    },
    transaction
  );

  return property;
}

async function listProperties(transaction, filters = {}) {
  const where = {};
  if (filters.propertyType) where.propertyType = String(filters.propertyType).toUpperCase();
  if (filters.publicationStatus) where.publicationStatus = String(filters.publicationStatus).toUpperCase();
  if (filters.availabilityStatus) where.availabilityStatus = String(filters.availabilityStatus).toUpperCase();
  return Property.findAll({
    where,
    include: [
      { model: PropertyOwner, as: 'owners' },
      { model: PropertyOffer, as: 'offers' },
      { model: PropertyAddress, as: 'address' },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function getProperty(id, transaction) {
  const property = await Property.findByPk(id, {
    include: [
      { model: PropertyOwner, as: 'owners' },
      { model: PropertyOffer, as: 'offers' },
      { model: PropertyAddress, as: 'address' },
    ],
    transaction,
  });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function updateProperty(id, payload, actorUserId, transaction) {
  const property = await Property.findByPk(id, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  const beforeJson = property.toJSON();

  const {
    title,
    propertyType,
    registryNumber,
    registryOffice,
    latitude,
    longitude,
    publicationStatus,
    availabilityStatus,
    address,
    addressId,
    addressLine,
    city,
    state,
    zipCode,
    areaTotalM2,
  } = payload;

  if (title !== undefined) property.title = title;
  if (addressLine !== undefined) property.addressLine = addressLine;
  if (city !== undefined) property.city = city;
  if (state !== undefined) property.state = state;
  if (zipCode !== undefined) property.zipCode = zipCode;
  if (areaTotalM2 !== undefined) property.areaTotalM2 = areaTotalM2;
  if (propertyType !== undefined) {
    const normalizedType = String(propertyType).toUpperCase();
    if (!PROPERTY_TYPES.includes(normalizedType)) {
      throw AppError.badRequest(`O campo "propertyType" deve ser um de: ${PROPERTY_TYPES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    property.propertyType = normalizedType;
  }
  if (registryNumber !== undefined) property.registryNumber = registryNumber;
  if (registryOffice !== undefined) property.registryOffice = registryOffice;
  if (latitude !== undefined) property.latitude = latitude;
  if (longitude !== undefined) property.longitude = longitude;
  if (publicationStatus !== undefined) {
    const normalized = String(publicationStatus).toUpperCase();
    if (!PUBLICATION_STATUSES.includes(normalized)) {
      throw AppError.badRequest(`O campo "publicationStatus" deve ser um de: ${PUBLICATION_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    property.publicationStatus = normalized;
  }
  if (availabilityStatus !== undefined) {
    const normalized = String(availabilityStatus).toUpperCase();
    if (!AVAILABILITY_STATUSES.includes(normalized)) {
      throw AppError.badRequest(`O campo "availabilityStatus" deve ser um de: ${AVAILABILITY_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    property.availabilityStatus = normalized;
  }
  if (addressId !== undefined) {
    property.addressId = addressId;
  } else if (address !== undefined) {
    property.addressId = await createOrReuseAddress(address, transaction);
  }

  property.updatedBy = actorUserId || null;
  await property.save({ transaction });

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property.update',
      entityType: 'Property',
      entityId: property.id,
      beforeJson,
      afterJson: property.toJSON(),
      reason: `Imóvel "${property.title}" (${property.internalCode}) atualizado.`,
    },
    transaction
  );

  return getProperty(id, transaction);
}

async function deleteProperty(id, actorUserId, transaction) {
  const property = await Property.findByPk(id, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  const beforeJson = property.toJSON();
  property.deletedBy = actorUserId || null;
  await property.save({ transaction });
  await property.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property.delete',
      entityType: 'Property',
      entityId: property.id,
      beforeJson,
      reason: `Imóvel "${property.title}" (${property.internalCode}) excluído.`,
    },
    transaction
  );

  return { id };
}

module.exports = {
  createProperty,
  listProperties,
  getProperty,
  updateProperty,
  deleteProperty,
  PROPERTY_TYPES,
  PUBLICATION_STATUSES,
  AVAILABILITY_STATUSES,
};
