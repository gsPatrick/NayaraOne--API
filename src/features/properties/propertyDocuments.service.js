'use strict';

const { PropertyDocument, Property } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * propertyDocuments.service.js — CRUD de "real_estate"."property_documents" (migration ...081).
 *
 * Cada linha é um dado documental do imóvel, no formato
 * `document_type` + `label` + `value_number` (número/identificador) + `value_amount` (valor
 * monetário) + `status`. Os tipos e status são os declarados na própria migration:
 *   - IPTU                       -> value_number = inscrição do IPTU
 *   - CONDO_FEE                  -> value_amount = valor do condomínio
 *   - REGISTRY                   -> value_number = matrícula / label = cartório
 *   - REGULARIZATION_CERTIFICATE -> status = REGULARIZADO|EM_ANALISE|PENDENTE
 *
 * `registry_number`/`registry_office` continuam também em properties (colunas próprias, usadas
 * por busca) — property_documents é o registro documental detalhado, não substitui aquelas.
 */

const DOCUMENT_TYPES = ['IPTU', 'CONDO_FEE', 'REGISTRY', 'REGULARIZATION_CERTIFICATE'];
const DOCUMENT_STATUSES = ['REGULARIZADO', 'EM_ANALISE', 'PENDENTE'];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createDocument(propertyId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { documentType, label, valueNumber, valueAmount, status } = payload;

  if (!documentType) {
    throw AppError.badRequest('O campo "documentType" é obrigatório.', 'PROPERTY_DOCUMENT_VALIDATION');
  }
  const normalizedType = String(documentType).toUpperCase();
  if (!DOCUMENT_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(
      `O campo "documentType" deve ser um de: ${DOCUMENT_TYPES.join(', ')}.`,
      'PROPERTY_DOCUMENT_VALIDATION'
    );
  }

  let normalizedStatus = null;
  if (status) {
    normalizedStatus = String(status).toUpperCase();
    if (!DOCUMENT_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(
        `O campo "status" deve ser um de: ${DOCUMENT_STATUSES.join(', ')}.`,
        'PROPERTY_DOCUMENT_VALIDATION'
      );
    }
  }

  return PropertyDocument.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      documentType: normalizedType,
      label: label || null,
      valueNumber: valueNumber || null,
      valueAmount: valueAmount !== undefined && valueAmount !== '' ? valueAmount : null,
      status: normalizedStatus,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listDocuments(propertyId, transaction) {
  await assertPropertyExists(propertyId, transaction);
  return PropertyDocument.findAll({ where: { propertyId }, order: [['created_at', 'ASC']], transaction });
}

async function deleteDocument(propertyId, documentId, transaction) {
  const document = await PropertyDocument.findOne({ where: { id: documentId, propertyId }, transaction });
  if (!document) throw AppError.notFound('Documento do imóvel não encontrado.', 'PROPERTY_DOCUMENT_NOT_FOUND');
  await document.destroy({ transaction });
  return { id: documentId };
}

module.exports = { createDocument, listDocuments, deleteDocument, DOCUMENT_TYPES, DOCUMENT_STATUSES };
