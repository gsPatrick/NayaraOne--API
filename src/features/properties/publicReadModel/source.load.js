'use strict';

const { Op } = require('sequelize');
const { Property, PropertyAddress, PropertyOffer, PropertyDocument, PropertyMedia, PropertyOwner, Person, File } = require('../../../models');

/**
 * loadPublicSource — lê as tabelas de ORIGEM do imóvel (a única leitura das tabelas de imóveis para publicação: adapters e
 * mappers nunca leem tabela, só o read model). Tudo sob a RLS da transação do chamador. Devolve null se o imóvel não existe.
 */
async function loadPublicSource(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) return null;
  const [address, offers, documents, media, owners] = await Promise.all([
    property.addressId ? PropertyAddress.findByPk(property.addressId, { transaction }) : null,
    PropertyOffer.findAll({ where: { propertyId, status: 'ACTIVE', askingPrice: { [Op.ne]: null } }, order: [['created_at', 'DESC'], ['id', 'ASC']], transaction }),
    PropertyDocument.findAll({ where: { propertyId, documentType: ['IPTU', 'CONDO_FEE'] }, order: [['created_at', 'DESC'], ['id', 'ASC']], transaction }),
    PropertyMedia.findAll({ where: { propertyId }, order: [['position', 'ASC'], ['created_at', 'ASC'], ['id', 'ASC']], transaction }),
    PropertyOwner.findAll({ where: { propertyId }, transaction }),
  ]);
  const keys = media.map((m) => m.storageKey).filter(Boolean);
  const cleanFiles = keys.length ? await File.findAll({ where: { companyId: property.companyId, storageKey: keys, scanStatus: 'CLEAN' }, attributes: ['storageKey'], transaction }) : [];
  const people = owners.length ? await Person.findAll({ where: { id: owners.map((o) => o.personId) }, attributes: ['legalName', 'preferredName'], transaction }) : [];
  const ownerNames = people.flatMap((p) => [p.legalName, p.preferredName]).filter((n) => typeof n === 'string' && n.trim().length >= 4);
  return { property, address, offers, documents, media, cleanKeys: new Set(cleanFiles.map((f) => f.storageKey)), ownerNames };
}

module.exports = { loadPublicSource };
