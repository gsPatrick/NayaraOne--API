'use strict';

const { PersonDocument, Person } = require('../../models');
const AppError = require('../../utils/AppError');

// Enum FECHADO confirmado pelo Caderno para person_documents.verification_status.
const VALID_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

async function createDocument(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const { documentType, fileId, versionNo, issuedAt, expiresAt, verificationStatus, extractedDataJson } = payload;
  if (!documentType || !fileId) {
    throw AppError.badRequest('Os campos "documentType" e "fileId" são obrigatórios.', 'PERSON_DOCUMENT_VALIDATION');
  }
  if (verificationStatus !== undefined && !VALID_VERIFICATION_STATUSES.includes(String(verificationStatus).toUpperCase())) {
    throw AppError.badRequest(
      `O campo "verificationStatus" deve ser um de: ${VALID_VERIFICATION_STATUSES.join(', ')}.`,
      'PERSON_DOCUMENT_VALIDATION'
    );
  }
  return PersonDocument.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      documentType: String(documentType).toUpperCase(),
      fileId,
      versionNo: versionNo || 1,
      issuedAt: issuedAt || null,
      expiresAt: expiresAt || null,
      verificationStatus: verificationStatus ? String(verificationStatus).toUpperCase() : 'PENDING',
      extractedDataJson: extractedDataJson || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listDocuments(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return PersonDocument.findAll({ where: { personId }, order: [['created_at', 'DESC']], transaction });
}

async function getDocument(personId, documentId, transaction) {
  const document = await PersonDocument.findOne({ where: { id: documentId, personId }, transaction });
  if (!document) throw AppError.notFound('Documento não encontrado.', 'PERSON_DOCUMENT_NOT_FOUND');
  return document;
}

async function updateDocument(personId, documentId, payload, actorUserId, transaction) {
  const document = await getDocument(personId, documentId, transaction);
  const { documentType, fileId, issuedAt, expiresAt, verificationStatus, verifiedBy, extractedDataJson } = payload;
  if (documentType !== undefined) document.documentType = String(documentType).toUpperCase();
  if (fileId !== undefined) document.fileId = fileId;
  if (issuedAt !== undefined) document.issuedAt = issuedAt;
  if (expiresAt !== undefined) document.expiresAt = expiresAt;
  if (verificationStatus !== undefined) {
    const normalized = String(verificationStatus).toUpperCase();
    if (!VALID_VERIFICATION_STATUSES.includes(normalized)) {
      throw AppError.badRequest(
        `O campo "verificationStatus" deve ser um de: ${VALID_VERIFICATION_STATUSES.join(', ')}.`,
        'PERSON_DOCUMENT_VALIDATION'
      );
    }
    document.verificationStatus = normalized;
    if (normalized !== 'PENDING') document.verifiedBy = verifiedBy || actorUserId || null;
  }
  if (extractedDataJson !== undefined) document.extractedDataJson = extractedDataJson;
  document.updatedBy = actorUserId || null;
  await document.save({ transaction });
  return document;
}

async function deleteDocument(personId, documentId, actorUserId, transaction) {
  const document = await getDocument(personId, documentId, transaction);
  document.deletedBy = actorUserId || null;
  await document.save({ transaction });
  await document.destroy({ transaction });
  return { id: documentId };
}

module.exports = { createDocument, listDocuments, getDocument, updateDocument, deleteDocument, VALID_VERIFICATION_STATUSES };
