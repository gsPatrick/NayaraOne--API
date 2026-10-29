'use strict';

// Fábrica de imóvel completo para a M9-D231: dado público limpo e valores CANARY em TODOS os campos internos (com COMMIT, banco descartável).
const { comTenant, uniqueSuffix } = require('../../integrations/dispatch/dispatchHelpers');
const {
  Property, PropertyAddress, PropertyOffer, PropertyDocument, PropertyMedia, PropertyOwner, PropertyInternalOccurrence, Person, File,
} = require('../../../src/models');

const CANARY = 'CANARY-INTERNAL';
const CANARY_PRICE = '7654321.12';
// Ponto exato (Curitiba) usado nos testes de coordenada.
const EXATO = { lat: -25.4284, lng: -49.2733 };

async function arquivo(tenant, t, nome, scanStatus) {
  const storageKey = `qa-m9-d231/${uniqueSuffix()}-${nome}`;
  await File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, storageKey, fileName: `${CANARY}-${nome}`, mimeType: 'image/jpeg', sizeBytes: 10,
    scanStatus, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t });
  return storageKey;
}

async function midia(tenant, t, propertyId, { nome, classification = 'PUBLIC', scanStatus = 'CLEAN', mediaType = 'PHOTO', quality = 'APPROVED', position = 0 }) {
  const storageKey = await arquivo(tenant, t, nome, scanStatus);
  return PropertyMedia.create({
    groupId: tenant.groupId, companyId: tenant.companyId, propertyId, mediaType, storageKey, originalName: `${CANARY}-${nome}`, mimeType: 'image/jpeg',
    sizeBytes: 10, position, classification, qualityStatus: quality, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t });
}

/**
 * Cria um imóvel PUBLISHED/AVAILABLE com oferta de venda ativa. `over` sobrescreve campos do imóvel; `visibility` define o endereço.
 * Devolve { id, ... } com os ids criados (fotos, proprietário).
 */
async function criarImovel(tenant, over = {}) {
  const sfx = uniqueSuffix();
  return comTenant(tenant, async (t) => {
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: tenant.userId, updatedBy: tenant.userId };
    const address = await PropertyAddress.create({
      zipCode: '80000-000', street: `${CANARY} Rua Interna`, number: '999', complement: `${CANARY}-compl`, neighborhood: 'Batel', city: 'Curitiba', state: 'PR',
    }, { transaction: t });
    const property = await Property.create({
      ...base,
      title: 'Apartamento de 3 quartos no Batel',
      internalCode: `${CANARY}-${sfx}`,
      propertyType: 'RESIDENTIAL',
      addressId: address.id,
      registryNumber: `${CANARY}-MAT-${sfx}`,
      registryOffice: `${CANARY}-cartorio`,
      latitude: EXATO.lat,
      longitude: EXATO.lng,
      areaTotalM2: 120.5,
      description: `${CANARY} descrição interna com a dívida do proprietário`,
      descriptionPublic: 'Apartamento claro, perto de tudo.',
      bedrooms: 3,
      parkingSpots: 2,
      attributesJson: { pool: true, elevator: true, usableAreaM2: 98.4, bathrooms: 2, ownerNote: `${CANARY}-attr`, videoPublicUrl: 'https://videos.exemplo.com/v/abc' },
      publicationStatus: 'PUBLISHED',
      availabilityStatus: 'AVAILABLE',
      addressVisibility: 'RESTRICTED',
      ...over,
    }, { transaction: t });
    const offer = await PropertyOffer.create({
      ...base, propertyId: property.id, offerType: 'SALE', askingPrice: '850000.00', confidentialMinPrice: CANARY_PRICE, status: 'ACTIVE',
    }, { transaction: t });
    await PropertyDocument.create({ ...base, propertyId: property.id, documentType: 'CONDO_FEE', label: `${CANARY}-label`, valueAmount: '1200.00' }, { transaction: t });
    await PropertyDocument.create({ ...base, propertyId: property.id, documentType: 'IPTU', label: `${CANARY}-iptu`, valueNumber: `${CANARY}-inscricao`, valueAmount: '310.50' }, { transaction: t });
    await PropertyInternalOccurrence.create({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, occurrenceType: 'OWNER_NOTE', description: `${CANARY} proprietário deve IPTU`, createdBy: tenant.userId }, { transaction: t });
    const owner = await Person.create({ ...base, personType: 'PF', legalName: `Zacarias Nogueira ${sfx}` }, { transaction: t });
    await PropertyOwner.create({ ...base, propertyId: property.id, personId: owner.id, ownershipPercent: 100, roleCode: 'OWNER' }, { transaction: t });
    const fotoOk = await midia(tenant, t, property.id, { nome: 'ok.jpg', position: 0 });
    const fotoSuja = await midia(tenant, t, property.id, { nome: 'suja.jpg', scanStatus: 'INFECTED', position: 1 });
    const fotoInterna = await midia(tenant, t, property.id, { nome: 'interna.jpg', classification: 'INTERNAL', position: 2 });
    return { id: property.id, ownerName: owner.legalName, offerId: offer.id, fotoOk: fotoOk.id, fotoSuja: fotoSuja.id, fotoInterna: fotoInterna.id, addressId: address.id };
  });
}

module.exports = { criarImovel, midia, CANARY, CANARY_PRICE, EXATO };
