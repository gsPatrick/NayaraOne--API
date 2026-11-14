'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { Op } = require('sequelize');
const { Property, PropertyOwner, PropertyOffer, PropertyAddress, PropertyMedia, PropertyDocument } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishPropertyCreated, publishPropertyUpdated, publishPropertySold, publishPropertyRented } = require('./propertyEvents.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishProperty, revalidatePublication } = require('./publicationGate.service');
const { ADDRESS_VISIBILITIES } = require('./publicReadModel/constants');
const { assertAddressBelongsToCompany } = require('./propertyAddress.guard');
const { assertEvidenceForCriticalChange, recordFieldChangeEvidence, propertyEntity } = require('../core-governance/data-quality/evidence');

const PROPERTY_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'LAND', 'RURAL'];
// M9-D403: política de endereço em conteúdo público de Marketing (padrão do banco: SO_BAIRRO).
const PUBLIC_ADDRESS_POLICIES = ['COMPLETO', 'RUA_SEM_NUMERO', 'SO_BAIRRO', 'OCULTO'];
const PUBLICATION_STATUSES = ['DRAFT', 'READY', 'PUBLISHED', 'INACTIVE'];
const AVAILABILITY_STATUSES = ['AVAILABLE', 'SOLD', 'RENTED', 'WITHDRAWN'];

// GAP REAL CORRIGIDO (auditoria externa Abacus AI, 11/10/2026 — Marco 3, CRMX-003 "Imóvel
// único"): dois imóveis com a mesma matrícula (MAT-AUDIT-001) eram aceitos sem bloqueio —
// "real_estate"."properties" não tinha nenhuma validação nem constraint de unicidade em
// registry_number. Checagem aqui dá o erro de negócio claro ANTES de bater no banco; a
// migration 20260101000329 adiciona o índice único parcial (group_id, registry_number) WHERE
// registry_number IS NOT NULL como rede de segurança contra corrida/bypass desta checagem —
// fail-closed de verdade, não só validação de aplicação. Matrícula vazia/null nunca conflita
// (imóvel pode ser cadastrado antes da documentação chegar).
async function assertRegistryNumberUnique(groupId, registryNumber, transaction, excludeId) {
  if (!registryNumber) return;
  const where = { groupId, registryNumber };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  const existing = await Property.findOne({ where, transaction });
  if (existing) {
    throw AppError.conflict(
      `Já existe um imóvel com a matrícula "${registryNumber}" cadastrado neste grupo (imóvel "${existing.title}", código ${existing.internalCode}). Matrícula física deve ser única (CRMX-003).`,
      'PROPERTY_REGISTRY_NUMBER_DUPLICATE'
    );
  }
}

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

async function createProperty(payload, actorUserId, transaction, tenant) {
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
    // Atributos de anúncio (migration ...093).
    description,
    bedrooms,
    parkingSpots,
    attributesJson,
  } = payload;
  // FIX (auditoria externa Nayara, re-auditoria round 2, M3-R01): a mensagem antiga sempre
  // listava os 5 campos juntos, mesmo quando só 1 estava faltando — groupId/companyId são
  // injetados pelo controller a partir da sessão e nunca aparecem no formulário, então listá-los
  // como "obrigatórios no formulário" induzia a um diagnóstico errado. Agora a mensagem cita só
  // o(s) campo(s) realmente ausente(s).
  const missingFields = [];
  if (!groupId) missingFields.push('groupId');
  if (!companyId) missingFields.push('companyId');
  if (!title) missingFields.push('title');
  if (!internalCode) missingFields.push('internalCode');
  if (!propertyType) missingFields.push('propertyType');
  if (missingFields.length) {
    throw AppError.badRequest(
      `Campo(s) obrigatório(s) ausente(s): ${missingFields.join(', ')}.`,
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

  await assertRegistryNumberUnique(groupId, registryNumber || null, transaction);

  const resolvedAddressId = addressId ? await assertAddressBelongsToCompany(addressId, companyId, transaction) : await createOrReuseAddress(address, transaction);

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
      description: description || null,
      bedrooms: bedrooms !== undefined && bedrooms !== '' ? bedrooms : null,
      parkingSpots: parkingSpots !== undefined && parkingSpots !== '' ? parkingSpots : null,
      attributesJson: attributesJson || null,
      // PUBLISHED nunca é gravado direto: o imóvel nasce DRAFT e, se pediram PUBLISHED, passa pelo gate único logo abaixo
      // (verificação independente de 11/11/2026, M3-09: a criação já publicada contornava vídeo, fotos e documentos).
      publicationStatus: publicationStatus && String(publicationStatus).toUpperCase() !== 'PUBLISHED' ? String(publicationStatus).toUpperCase() : 'DRAFT',
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

  if (publicationStatus && String(publicationStatus).toUpperCase() === 'PUBLISHED') {
    await publishProperty(property, tenant || { groupId, companyId }, actorUserId, transaction, { source: 'POST /properties' }); // M9-D409: emite property.published
  }

  return property;
}

// Sub-recursos sempre devolvidos junto do imóvel. `media` e `documents` entram aqui para que a
// ficha monte a galeria e o bloco de documentação sem uma chamada extra por imóvel — os dois
// continuam com CRUD próprio em /properties/:id/media e /properties/:id/documents.
// PropertyInternalOccurrence NUNCA entra nesta lista: é conteúdo restrito, exposto só pelos
// endpoints com a permissão dedicada 'properties:internal'
// (ver propertyInternalOccurrences.service.js).
// O preço mínimo confidencial das ofertas só vem para quem tem properties:internal (M3-07, DI-M3IM-4): o escopo padrão de
// PropertyOffer o exclui, inclusive dentro do include.
function propertyInclude({ revealConfidential = false } = {}) {
  return [
    { model: PropertyOwner, as: 'owners' },
    { model: revealConfidential ? PropertyOffer.scope('withConfidentialPrice') : PropertyOffer, as: 'offers' },
    { model: PropertyAddress, as: 'address' },
    { model: PropertyMedia, as: 'media' },
    { model: PropertyDocument, as: 'documents' },
  ];
}

async function listProperties(transaction, filters = {}, options = {}) {
  const where = {};
  if (filters.propertyType) where.propertyType = String(filters.propertyType).toUpperCase();
  if (filters.publicationStatus) where.publicationStatus = String(filters.publicationStatus).toUpperCase();
  if (filters.availabilityStatus) where.availabilityStatus = String(filters.availabilityStatus).toUpperCase();
  return Property.findAll({
    where,
    include: propertyInclude(options),
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function getProperty(id, transaction, options = {}) {
  const property = await Property.findByPk(id, {
    include: propertyInclude(options),
    transaction,
  });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function updateProperty(id, payload, actorUserId, transaction, tenant, options = {}) {
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
    description,
    bedrooms,
    parkingSpots,
    attributesJson,
    publicAddressPolicy,
    addressVisibility,
    descriptionPublic,
  } = payload;

  if (publicAddressPolicy !== undefined) {
    const normalizedPolicy = String(publicAddressPolicy).toUpperCase();
    if (!PUBLIC_ADDRESS_POLICIES.includes(normalizedPolicy)) {
      throw AppError.badRequest(
        `O campo "publicAddressPolicy" deve ser um de: ${PUBLIC_ADDRESS_POLICIES.join(', ')}.`,
        'PROPERTY_VALIDATION'
      );
    }
    property.publicAddressPolicy = normalizedPolicy;
  }
  // M9-D231: visibilidade do endereço no site e nos portais e texto público próprio (passa por redação ao entrar no read model).
  if (addressVisibility !== undefined) {
    const normalizedVisibility = String(addressVisibility).toUpperCase();
    if (!ADDRESS_VISIBILITIES.includes(normalizedVisibility)) {
      throw AppError.badRequest(`O campo "addressVisibility" deve ser um de: ${ADDRESS_VISIBILITIES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    property.addressVisibility = normalizedVisibility;
  }
  if (descriptionPublic !== undefined) {
    if (descriptionPublic !== null && String(descriptionPublic).length > 5000) {
      throw AppError.badRequest('O campo "descriptionPublic" aceita até 5000 caracteres.', 'PROPERTY_VALIDATION');
    }
    property.descriptionPublic = descriptionPublic === null || String(descriptionPublic).trim() === '' ? null : String(descriptionPublic);
  }
  if (description !== undefined) property.description = description;
  if (bedrooms !== undefined) property.bedrooms = bedrooms;
  if (parkingSpots !== undefined) property.parkingSpots = parkingSpots;
  if (attributesJson !== undefined) property.attributesJson = attributesJson;
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
  if (registryNumber !== undefined) {
    await assertRegistryNumberUnique(property.groupId, registryNumber || null, transaction, property.id);
    property.registryNumber = registryNumber;
  }
  if (registryOffice !== undefined) property.registryOffice = registryOffice;
  if (latitude !== undefined) property.latitude = latitude;
  if (longitude !== undefined) property.longitude = longitude;
  if (publicationStatus !== undefined) {
    const normalized = String(publicationStatus).toUpperCase();
    if (!PUBLICATION_STATUSES.includes(normalized)) {
      throw AppError.badRequest(`O campo "publicationStatus" deve ser um de: ${PUBLICATION_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    // PATCH não publica sozinho: a transição para PUBLISHED passa pelo gate único depois de aplicados os demais campos
    // (o gate confere o imóvel como ele vai ficar). Ver publicationGate.service.js.
    if (normalized !== 'PUBLISHED') property.publicationStatus = normalized;
  }
  if (availabilityStatus !== undefined) {
    const normalized = String(availabilityStatus).toUpperCase();
    if (!AVAILABILITY_STATUSES.includes(normalized)) {
      throw AppError.badRequest(`O campo "availabilityStatus" deve ser um de: ${AVAILABILITY_STATUSES.join(', ')}.`, 'PROPERTY_VALIDATION');
    }
    property.availabilityStatus = normalized;
  }
  if (addressId !== undefined) {
    property.addressId = await assertAddressBelongsToCompany(addressId, property.companyId, transaction);
  } else if (address !== undefined) {
    property.addressId = await createOrReuseAddress(address, transaction);
  }

  // M9-D807: a matrícula (campo crítico) só muda com origem e comprovante, gravados na mesma transação.
  const entity = propertyEntity(property, beforeJson);
  const assertion = await assertEvidenceForCriticalChange(entity, registryNumber === undefined ? {} : { registryNumber }, payload.changeEvidence, { transaction, actorUserId });
  property.updatedBy = actorUserId || null;
  await property.save({ transaction });
  await recordFieldChangeEvidence(entity, assertion, { transaction, actorUserId });
  await publishPropertyUpdated(property, transaction);
  // M9-D409: a transição para publicado sai como evento próprio, emitido pelo gate único.
  const askedToPublish = publicationStatus !== undefined && String(publicationStatus).toUpperCase() === 'PUBLISHED';
  if (askedToPublish && beforeJson.publicationStatus !== 'PUBLISHED') {
    await publishProperty(property, tenant || property, actorUserId, transaction, { source: 'PATCH /properties/:id' });
  } else if (beforeJson.publicationStatus === 'PUBLISHED') {
    await revalidatePublication(property.id, tenant || property, actorUserId, transaction, 'cadastro do imóvel alterado');
  }
  if (property.availabilityStatus !== beforeJson.availabilityStatus) {
    if (property.availabilityStatus === 'SOLD') await publishPropertySold(property, transaction);
    if (property.availabilityStatus === 'RENTED') await publishPropertyRented(property, transaction);
  }

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

  return getProperty(id, transaction, options);
}

async function deleteProperty(id, actorUserId, transaction) {
  await legalHold.assertNotOnHold('PROPERTY', id, transaction); // M9-D912
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
