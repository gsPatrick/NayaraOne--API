'use strict';

const { PersonDocument, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { onlyDigits, isValidTaxIdDigits } = require('./personDocumentFormat.service');

// Enum FECHADO confirmado pelo Caderno para person_documents.verification_status.
const VALID_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];

const FIELD_LABELS = { name: 'Nome', taxId: 'CPF/CNPJ', income: 'Renda', accountNumber: 'Conta', issuedAt: 'Emissão', expiresAt: 'Validade' };
const isEmpty = (v) => v === undefined || v === null || v === '';

function normalizeManualField(field, raw) {
  const text = String(raw).trim();
  if (field === 'taxId') {
    const digits = onlyDigits(text);
    if (!isValidTaxIdDigits(digits)) {
      throw AppError.badRequest('O CPF/CNPJ informado é inválido. Confira os dígitos no arquivo original.', 'PERSON_DOCUMENT_MANUAL_FIELD_INVALID');
    }
    return digits;
  }
  if (field === 'income') {
    const value = Number(text.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw AppError.badRequest('A renda informada precisa ser um valor maior que zero.', 'PERSON_DOCUMENT_MANUAL_FIELD_INVALID');
    }
    return value;
  }
  if (field === 'issuedAt' || field === 'expiresAt') {
    if (Number.isNaN(new Date(text).getTime())) {
      throw AppError.badRequest(`A data informada em ${FIELD_LABELS[field]} é inválida.`, 'PERSON_DOCUMENT_MANUAL_FIELD_INVALID');
    }
    return text;
  }
  if (text.length < 3 || text.length > 120) {
    throw AppError.badRequest(`O campo ${FIELD_LABELS[field]} informado precisa ter entre 3 e 120 caracteres.`, 'PERSON_DOCUMENT_MANUAL_FIELD_INVALID');
  }
  return text;
}

/**
 * assertReadingAllowsVerification — só se marca um documento como VERIFIED se ele é legível e se os campos críticos do
 * tipo existem: lidos do arquivo ou informados por quem verifica (`manualFields`, conferidos no original, validados aqui
 * e auditados). O resultado da leitura é o que está gravado, nunca o que vem na mesma requisição. Devolve os campos
 * informados à mão, já normalizados. `reading` é a leitura gravada (null quando o documento não passou pela leitura).
 */
function assertReadingAllowsVerification(documentType, reading, manualFieldsInput) {
  // Carregado aqui porque documentIngestion.service também importa este módulo (dependência circular).
  const { CRITICAL_FIELDS_BY_TYPE, validateCriticalFields } = require('./documentIngestion.service');
  if (reading && reading.illegible === true) {
    throw AppError.unprocessable(
      'A leitura automática não conseguiu ler este documento. Recuse o documento e peça um arquivo legível antes de verificar.',
      'PERSON_DOCUMENT_ILLEGIBLE'
    );
  }
  const critical = CRITICAL_FIELDS_BY_TYPE[String(documentType).toUpperCase()] || [];
  const read = (reading && reading.fields) || {};
  const manual = manualFieldsInput && typeof manualFieldsInput === 'object' ? manualFieldsInput : {};
  const entries = [];
  const missing = [];
  for (const field of critical) {
    if (!isEmpty(read[field])) continue;
    if (isEmpty(manual[field]) || String(manual[field]).trim() === '') {
      missing.push(field);
      continue;
    }
    entries.push([field, normalizeManualField(field, manual[field])]);
  }
  if (missing.length) {
    throw AppError.unprocessable(
      `Não é possível verificar: a leitura não encontrou ${missing.map((f) => FIELD_LABELS[f]).join(', ')} neste documento. Informe ${missing.length > 1 ? 'esses dados' : 'esse dado'} conferindo o arquivo original, ou recuse o documento.`,
      'PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING'
    );
  }
  // Valores lidos e informados juntos precisam passar nas mesmas regras de formato do cadastro.
  const merged = { ...read, ...Object.fromEntries(entries) };
  const check = validateCriticalFields(String(documentType).toUpperCase(), merged);
  if (!check.valid) {
    throw AppError.unprocessable(`Não é possível verificar: ${check.missing.join(', ')}.`, 'PERSON_DOCUMENT_CRITICAL_FIELDS_MISSING');
  }
  return entries;
}

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

// A unicidade é (pessoa, tipo, versão), inclusive nas linhas apagadas: enviar de novo um documento do
// mesmo tipo cria a versão seguinte e a anterior continua no histórico.
async function nextVersionNo(personId, documentType, transaction) {
  const latest = await PersonDocument.max('versionNo', {
    where: { personId, documentType: String(documentType).toUpperCase() },
    paranoid: false,
    transaction,
  });
  return (Number(latest) || 0) + 1;
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
  const finalStatus = verificationStatus ? String(verificationStatus).toUpperCase() : 'PENDING';
  let finalExtracted = extractedDataJson || null;
  if (finalStatus === 'VERIFIED') {
    // Documento criado já verificado: não há leitura gravada pelo servidor, então os campos críticos vêm de quem verifica.
    const entries = assertReadingAllowsVerification(documentType, null, payload.manualFields);
    if (entries.length) {
      finalExtracted = { ...(finalExtracted || {}), manualFields: Object.fromEntries(entries), manualFieldsConfirmedBy: actorUserId || null, manualFieldsConfirmedAt: new Date().toISOString() };
    }
  }
  return PersonDocument.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      documentType: String(documentType).toUpperCase(),
      fileId,
      versionNo: versionNo || (await nextVersionNo(personId, documentType, transaction)),
      issuedAt: issuedAt || null,
      expiresAt: expiresAt || null,
      verificationStatus: finalStatus,
      extractedDataJson: finalExtracted,
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
  const beforeJson = document.toJSON();
  const { documentType, fileId, issuedAt, expiresAt, verificationStatus, verifiedBy, extractedDataJson } = payload;
  if (documentType !== undefined) document.documentType = String(documentType).toUpperCase();
  if (fileId !== undefined) document.fileId = fileId;
  if (issuedAt !== undefined) document.issuedAt = issuedAt;
  if (expiresAt !== undefined) document.expiresAt = expiresAt;
  let manualEntries = [];
  if (verificationStatus !== undefined) {
    const normalized = String(verificationStatus).toUpperCase();
    if (!VALID_VERIFICATION_STATUSES.includes(normalized)) {
      throw AppError.badRequest(
        `O campo "verificationStatus" deve ser um de: ${VALID_VERIFICATION_STATUSES.join(', ')}.`,
        'PERSON_DOCUMENT_VALIDATION'
      );
    }
    if (normalized === 'VERIFIED' && document.verificationStatus !== 'VERIFIED') {
      // A leitura valendo é a gravada (document.extractedDataJson ainda é a do banco neste ponto), não a desta requisição.
      // Campos que a pessoa digitou na revisão (extractedDataJson.fields desta requisição) valem como informados à mão:
      // só preenchem o que a leitura gravada não achou e passam pelas mesmas validações.
      const digitados = { ...((extractedDataJson && extractedDataJson.fields) || {}), ...(payload.manualFields || {}) };
      manualEntries = assertReadingAllowsVerification(document.documentType, document.extractedDataJson, digitados);
    }
    document.verificationStatus = normalized;
    if (normalized !== 'PENDING') document.verifiedBy = verifiedBy || actorUserId || null;
  }
  if (extractedDataJson !== undefined) {
    // O resultado da leitura (ilegível, confiança, origem) não é editável: só os campos.
    const prev = document.extractedDataJson || {};
    document.extractedDataJson = {
      ...extractedDataJson,
      ...(prev.illegible !== undefined ? { illegible: prev.illegible } : {}),
      ...(prev.sourceFileId ? { sourceFileId: prev.sourceFileId } : {}),
      ...(prev.confidence !== undefined ? { confidence: prev.confidence } : {}),
      ...(prev.extractionMeta ? { extractionMeta: prev.extractionMeta } : {}),
    };
  }
  if (manualEntries.length) {
    document.extractedDataJson = {
      ...(document.extractedDataJson || {}),
      manualFields: Object.fromEntries(manualEntries),
      manualFieldsConfirmedBy: actorUserId || null,
      manualFieldsConfirmedAt: new Date().toISOString(),
    };
  }
  document.updatedBy = actorUserId || null;
  await document.save({ transaction });
  await registrarAuditoria(
    {
      groupId: document.groupId,
      companyId: document.companyId,
      actorUserId,
      action: 'people.document.update',
      entityType: 'PersonDocument',
      entityId: document.id,
      beforeJson,
      afterJson: document.toJSON(),
      reason: manualEntries.length
        ? `Documento da pessoa verificado com dado informado por quem verificou, conferido no arquivo original: ${manualEntries.map(([k]) => FIELD_LABELS[k]).join(', ')}.`
        : 'Documento da pessoa atualizado (inclui a validação humana dos dados extraídos).',
    },
    transaction
  );
  return document;
}

async function deleteDocument(personId, documentId, actorUserId, transaction) {
  const document = await getDocument(personId, documentId, transaction);
  document.deletedBy = actorUserId || null;
  await document.save({ transaction });
  await document.destroy({ transaction });
  return { id: documentId };
}

module.exports = { assertReadingAllowsVerification, nextVersionNo, createDocument, listDocuments, getDocument, updateDocument, deleteDocument, VALID_VERIFICATION_STATUSES };
