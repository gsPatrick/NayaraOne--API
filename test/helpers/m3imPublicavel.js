'use strict';

/**
 * Fixture do Marco 3 (verificação de 11/11/2026): deixa um imóvel cumprindo o gate de publicação como ele é agora — oferta
 * ACTIVE, vídeo e fotos com ARQUIVO e qualidade APROVADA, documentos obrigatórios com arquivo, endereço completo e proprietário.
 * Grava direto pelos models (o envio pela rota, com antivírus, é provado em test/m3im.imovelArquivos.http.test.js); os arquivos
 * nascem como saem do POST /files: scan_status CLEAN.
 */
const crypto = require('crypto');
const { File, PropertyMedia, PropertyDocument, PropertyOwner, PropertyOffer, Person } = require('../../src/models');

async function arquivoLimpo(tenant, transaction, { nome, mimeType }) {
  return File.create({
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    storageKey: `local-db/m3im/${crypto.randomUUID()}-${nome}`,
    fileName: nome,
    mimeType,
    sizeBytes: 10,
    scanStatus: 'CLEAN',
    scannedAt: new Date(),
    uploadedByUserId: tenant.userId,
    createdBy: tenant.userId,
    updatedBy: tenant.userId,
  }, { transaction });
}

async function midiaComArquivo(tenant, transaction, propertyId, { mediaType, qualityStatus = 'APPROVED', position = 0 }) {
  const video = mediaType === 'VIDEO';
  const file = await arquivoLimpo(tenant, transaction, { nome: video ? 'tour.mp4' : `foto-${position}.jpg`, mimeType: video ? 'video/mp4' : 'image/jpeg' });
  return PropertyMedia.create({
    groupId: tenant.groupId, companyId: tenant.companyId, propertyId, mediaType, fileId: file.id, storageKey: file.storageKey,
    originalName: file.fileName, mimeType: file.mimeType, sizeBytes: 10, position, qualityStatus, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction });
}

async function documentoComArquivo(tenant, transaction, propertyId, documentType) {
  const file = await arquivoLimpo(tenant, transaction, { nome: `${documentType.toLowerCase()}.pdf`, mimeType: 'application/pdf' });
  return PropertyDocument.create({
    groupId: tenant.groupId, companyId: tenant.companyId, propertyId, documentType, fileId: file.id, valueNumber: `${documentType}-${propertyId.slice(0, 8)}`,
    createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction });
}

async function proprietario(tenant, transaction, propertyId) {
  const person = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proprietário M3IM ${crypto.randomUUID().slice(0, 8)}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
  return PropertyOwner.create({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId, personId: person.id, ownershipPercent: 100, roleCode: 'OWNER', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
}

/**
 * Completa o imóvel para o gate. `opcoes` permite deixar UMA peça de fora para provar o bloqueio específico:
 * { video: false | 'REJECTED' | 'PENDING', fotos: n, documentos: [...], proprietario: false, oferta: false }.
 */
async function tornarPublicavel(tenant, transaction, property, opcoes = {}) {
  const { video = 'APPROVED', fotos = 3, documentos = ['REGISTRY', 'IPTU'], comProprietario = true, oferta = true } = opcoes;
  let offer = null;
  if (oferta) {
    offer = await PropertyOffer.create({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, offerType: 'SALE', askingPrice: 500000, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
  }
  if (video) await midiaComArquivo(tenant, transaction, property.id, { mediaType: 'VIDEO', qualityStatus: video === true ? 'APPROVED' : video, position: 0 });
  for (let i = 0; i < fotos; i += 1) await midiaComArquivo(tenant, transaction, property.id, { mediaType: 'IMAGE', position: i + 1 });
  for (const tipo of documentos) await documentoComArquivo(tenant, transaction, property.id, tipo);
  if (comProprietario) await proprietario(tenant, transaction, property.id);
  return { offer };
}

// Endereço "achatado" completo (aceito pelo campo obrigatório "address" do gate).
const ENDERECO = { addressLine: 'Rua das Palmeiras, 100', city: 'Campinas', state: 'SP', zipCode: '13010-000' };

module.exports = { arquivoLimpo, midiaComArquivo, documentoComArquivo, proprietario, tornarPublicavel, ENDERECO };
