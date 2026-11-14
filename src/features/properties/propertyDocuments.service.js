'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { PropertyDocument, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPropertyPublicSourceChanged } = require('./propertyEvents.service');
const { resolveScannedPropertyFile } = require('./propertyFile.guard');
const { revalidatePublication } = require('./publicationGate.service');
const { DOCUMENT_TYPES } = require('./propertyPublication.settings');

/**
 * propertyDocuments.service.js — documentos do imóvel ("real_estate"."property_documents"; livro do Marco 3 §3 "Matrícula, IPTU
 * etc." e §6 "Property: ... documentos").
 *
 * Cada documento é o ARQUIVO real (file_id em people.files, examinado de novo pelo antivírus no vínculo — propertyFile.guard)
 * mais os dados que o identificam: `document_type` + `label` + `value_number` (número/identificador) + `value_amount` (valor) +
 * `status`. Verificação independente de 11/11/2026 (M3-06): antes eram só metadados, sem arquivo. Linhas antigas sem arquivo
 * continuam listadas (nada some), mas não contam para o gate de publicação.
 *   - IPTU                       -> value_number = inscrição do IPTU
 *   - CONDO_FEE                  -> value_amount = valor do condomínio
 *   - REGISTRY                   -> value_number = matrícula / label = cartório
 *   - REGULARIZATION_CERTIFICATE -> status = REGULARIZADO|EM_ANALISE|PENDENTE
 * Criar e apagar é auditado; apagar documento de imóvel publicado reconfere o gate.
 */
const DOCUMENT_STATUSES = ['REGULARIZADO', 'EM_ANALISE', 'PENDENTE'];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createDocument(propertyId, payload, actor, transaction) {
  const { auth, actorUserId } = actor;
  const property = await assertPropertyExists(propertyId, transaction);
  const { documentType, label, valueNumber, valueAmount, status, fileId } = payload || {};

  if (!documentType) {
    throw AppError.badRequest('O campo "documentType" é obrigatório.', 'PROPERTY_DOCUMENT_VALIDATION');
  }
  const normalizedType = String(documentType).toUpperCase();
  if (!DOCUMENT_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "documentType" deve ser um de: ${DOCUMENT_TYPES.join(', ')}.`, 'PROPERTY_DOCUMENT_VALIDATION');
  }
  let normalizedStatus = null;
  if (status) {
    normalizedStatus = String(status).toUpperCase();
    if (!DOCUMENT_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`O campo "status" deve ser um de: ${DOCUMENT_STATUSES.join(', ')}.`, 'PROPERTY_DOCUMENT_VALIDATION');
    }
  }
  const { file, antivirus } = await resolveScannedPropertyFile(fileId, {
    use: 'DOCUMENT', auth, tenant: { groupId: property.groupId, companyId: property.companyId }, actorUserId, transaction,
  });

  const created = await PropertyDocument.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      documentType: normalizedType,
      fileId: file.id,
      label: label || null,
      valueNumber: valueNumber || null,
      valueAmount: valueAmount !== undefined && valueAmount !== '' ? valueAmount : null,
      status: normalizedStatus,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await registrarAuditoria({
    groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.document.create', entityType: 'PropertyDocument', entityId: created.id,
    afterJson: { ...created.toJSON(), fileName: file.fileName, antivirus }, reason: `Documento ${normalizedType} anexado ao imóvel "${property.title}" (arquivo examinado pelo antivírus).`,
  }, transaction);
  await publishPropertyPublicSourceChanged(property, transaction);
  return created;
}

async function listDocuments(propertyId, transaction) {
  await assertPropertyExists(propertyId, transaction);
  return PropertyDocument.findAll({ where: { propertyId }, order: [['created_at', 'ASC']], transaction });
}

async function deleteDocument(propertyId, documentId, actor, transaction) {
  const { auth, actorUserId } = actor;
  await legalHold.assertNotOnHold('PROPERTY', propertyId, transaction); // M9-D912
  const document = await PropertyDocument.findOne({ where: { id: documentId, propertyId }, transaction });
  if (!document) throw AppError.notFound('Documento do imóvel não encontrado.', 'PROPERTY_DOCUMENT_NOT_FOUND');
  const beforeJson = document.toJSON();
  await document.destroy({ transaction });
  const property = await assertPropertyExists(propertyId, transaction);
  await registrarAuditoria({
    groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.document.delete', entityType: 'PropertyDocument', entityId: documentId,
    beforeJson, reason: `Documento ${beforeJson.documentType} removido do imóvel "${property.title}".`,
  }, transaction);
  const unpublished = await revalidatePublication(propertyId, auth || property, actorUserId, transaction, `documento ${beforeJson.documentType} removido`);
  await publishPropertyPublicSourceChanged(property, transaction);
  return { id: documentId, unpublished: Boolean(unpublished), gateCode: unpublished };
}

module.exports = { createDocument, listDocuments, deleteDocument, DOCUMENT_TYPES, DOCUMENT_STATUSES };
