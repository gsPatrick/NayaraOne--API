'use strict';

const { Op } = require('sequelize');
const { PropertyMedia, PropertyDocument, PropertyAddress, PropertyOwner } = require('../../models');
const { getSetting } = require('../settings/settings.service');
const {
  REQUIRED_DOCUMENT_TYPES_KEY, REQUIRED_FIELDS_KEY, DEFAULT_REQUIRED_DOCUMENT_TYPES, DEFAULT_REQUIRED_FIELDS, DOCUMENT_TYPES, FIELD_CATALOG, parseList,
} = require('./propertyPublication.settings');

/**
 * Fatos do gate de publicação (Guia do Marco 3 §6 `buildPublicationFacts`), lidos SEMPRE do banco e do imóvel como ele vai ficar
 * (a instância em memória do PATCH, já com os campos alterados). Só conta o que tem arquivo real e qualidade aprovada:
 *  - vídeo: VIDEO com arquivo e quality_status APPROVED (vídeo pendente ou recusado não conta — verificação de 11/11/2026, M3-09);
 *  - fotos: IMAGE/PHOTO com arquivo e APPROVED;
 *  - documentos: tipos com arquivo, comparados com a lista configurada (real_estate.publication.required_document_types);
 *  - campos: os configurados em real_estate.publication.required_fields, conferidos no imóvel.
 */
const PHOTO_TYPES = ['IMAGE', 'PHOTO'];
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

async function addressComplete(property, transaction) {
  if (property.addressId) {
    const address = await PropertyAddress.findByPk(property.addressId, { transaction });
    if (address && ['zipCode', 'street', 'neighborhood', 'city', 'state'].every((k) => filled(address[k]))) return true;
  }
  // Endereço "achatado" legado (colunas da própria properties).
  return ['addressLine', 'city', 'state', 'zipCode'].every((k) => filled(property[k]));
}

async function activeOwnerCount(property, transaction) {
  const today = new Date().toISOString().slice(0, 10);
  return PropertyOwner.count({
    where: { propertyId: property.id, [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gte]: today } }] },
    transaction,
  });
}

const FIELD_CHECKS = {
  title: (p) => filled(p.title),
  internalCode: (p) => filled(p.internalCode),
  propertyType: (p) => filled(p.propertyType),
  address: (p, ctx) => ctx.addressComplete,
  owner: (p, ctx) => ctx.ownerCount > 0,
  description: (p) => filled(p.description),
  descriptionPublic: (p) => filled(p.descriptionPublic),
  areaTotalM2: (p) => filled(p.areaTotalM2) && Number(p.areaTotalM2) > 0,
  bedrooms: (p) => filled(p.bedrooms),
  parkingSpots: (p) => filled(p.parkingSpots),
  registryNumber: (p) => filled(p.registryNumber),
  coordinates: (p) => filled(p.latitude) && filled(p.longitude),
};

/** Lista configurada; valor gravado inválido (fora do catálogo) cai no padrão, nunca numa lista vazia que liberaria tudo. */
async function configuredList(key, fallback, allowed, tenant, transaction) {
  const raw = await getSetting(key, tenant, transaction, fallback);
  const items = parseList(raw).filter((i) => allowed.includes(i));
  return items.length ? items : parseList(fallback);
}

async function buildPublicationFacts(property, tenant, transaction) {
  const withFile = { propertyId: property.id, fileId: { [Op.ne]: null }, qualityStatus: 'APPROVED' };
  const approvedVideoCount = await PropertyMedia.count({ where: { ...withFile, mediaType: 'VIDEO' }, transaction });
  const approvedPhotoCount = await PropertyMedia.count({ where: { ...withFile, mediaType: PHOTO_TYPES }, transaction });

  const requiredDocumentTypes = await configuredList(REQUIRED_DOCUMENT_TYPES_KEY, DEFAULT_REQUIRED_DOCUMENT_TYPES, DOCUMENT_TYPES, tenant, transaction);
  const docs = await PropertyDocument.findAll({ where: { propertyId: property.id, fileId: { [Op.ne]: null } }, attributes: ['documentType'], transaction });
  const presentTypes = new Set(docs.map((d) => d.documentType));
  const missingDocumentTypes = requiredDocumentTypes.filter((t) => !presentTypes.has(t));

  const requiredFields = await configuredList(REQUIRED_FIELDS_KEY, DEFAULT_REQUIRED_FIELDS, Object.keys(FIELD_CATALOG), tenant, transaction);
  const ctx = {
    addressComplete: requiredFields.includes('address') ? await addressComplete(property, transaction) : true,
    ownerCount: requiredFields.includes('owner') ? await activeOwnerCount(property, transaction) : 0,
  };
  const missingFields = requiredFields.filter((f) => !FIELD_CHECKS[f](property, ctx));

  return {
    media: { hasVideo: approvedVideoCount > 0, approvedVideoCount, approvedPhotoCount },
    documents: { requiredDocumentTypes, missingDocumentTypes, hasRequiredDocuments: missingDocumentTypes.length === 0 },
    fields: { requiredFields, missingFields, hasRequiredFields: missingFields.length === 0 },
  };
}

module.exports = { buildPublicationFacts, FIELD_CHECKS, PHOTO_TYPES };
