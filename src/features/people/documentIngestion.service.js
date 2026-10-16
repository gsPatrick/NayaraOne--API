'use strict';

const { Person, PersonDocument, Task } = require('../../models');
const AppError = require('../../utils/AppError');
const { uploadFile } = require('../files/files.service');
const { resolveAntivirusAdapter, resolveOcrAdapter } = require('./adapters/resolveDocumentAdapters');
const { validateDocumentFormat, onlyDigits } = require('./personDocumentFormat.service');

/**
 * documentIngestion.service.js — item 2 do ciclo de auditoria externa (Marco 3).
 *
 * Contrato bruto confirmado (Guia do Marcelo §5 "Cadastro por documento e IA"):
 *   "Upload -> antivírus -> hash -> classificação -> OCR/IA -> dados sugeridos."
 *   "Dados extraídos ficam com source_file_id e confidence."
 *   "CPF/CNPJ, nome, renda, conta e datas críticas exigem validação antes de persistir
 *    quando não houver fonte confiável estruturada."
 *   "IA nunca sobrescreve cadastro existente silenciosamente."
 *   "Documento ilegível gera pendência, não dado inventado."
 * E o caderno físico (linha ~9562): "Upload → malware scan → hash → OCR/IA → sugestão →
 * validação."
 *
 * Até este ciclo só existia validação de CPF/CNPJ DIGITADO manualmente
 * (personDocumentFormat.service.js, usado por person.service.js). Este service é o pipeline
 * completo: recebe o arquivo, passa por antivírus (quarentena se infectado — AppError, nunca
 * persiste), delega hash+storage para files.service.js (que já calcula checksum_sha256),
 * classifica o tipo de documento, extrai dados via adapter de OCR/IA (mockável — ver
 * adapters/OcrAdapter.js), valida os campos críticos conforme o tipo, e persiste em
 * "people"."person_documents" com extracted_data_json = { ...fields, sourceFileId, confidence }
 * (a tabela e a coluna JÁ EXISTEM — migration 20260101000086 — sem precisar de DDL novo).
 *
 * "Documento ilegível gera pendência, não dado inventado": quando a extração falha
 * (adapter.illegible === true) ou a confiança fica abaixo de CONFIDENCE_THRESHOLD, o
 * documento é persistido com verification_status='PENDING' e SEM nenhum campo fabricado
 * (extractedDataJson.fields fica vazio/como veio do adapter) + abre uma "core"."tasks"
 * (mesma tabela polimórfica usada pelo CRM) como pendência de revisão manual, vinculada à
 * pessoa (related_entity_type='people.persons').
 */

const CONFIDENCE_THRESHOLD = 0.7;

// Campos "críticos" por tipo de documento — Caderno: "CPF/CNPJ, nome, renda, conta e datas
// críticas exigem validação antes de persistir quando não houver fonte confiável estruturada."
const CRITICAL_FIELDS_BY_TYPE = {
  RG: ['name'],
  CIN: ['name'],
  CNH: ['name', 'issuedAt', 'expiresAt'],
  IR: ['name', 'taxId', 'income'],
  HOLERITE: ['name', 'income'],
  BANK_STATEMENT: ['name', 'accountNumber'],
};

function validateCriticalFields(documentType, fields) {
  const requiredFields = CRITICAL_FIELDS_BY_TYPE[documentType] || [];
  const missing = requiredFields.filter((field) => fields[field] === undefined || fields[field] === null || fields[field] === '');
  if (missing.length > 0) {
    return { valid: false, missing };
  }

  if (fields.taxId) {
    const digits = onlyDigits(String(fields.taxId));
    const taxIdType = digits.length === 14 ? 'CNPJ' : 'CPF';
    // Lança AppError 400 se o formato for inválido — fail fast, nunca persiste CPF/CNPJ malformado
    // sugerido pela IA como se fosse confirmado.
    validateDocumentFormat(taxIdType, digits);
  }

  if (fields.income !== undefined && (typeof fields.income !== 'number' || Number.isNaN(fields.income) || fields.income < 0)) {
    return { valid: false, missing: ['income (formato inválido)'] };
  }

  const dateFields = ['issuedAt', 'expiresAt'];
  for (const dateField of dateFields) {
    if (fields[dateField] !== undefined && Number.isNaN(new Date(fields[dateField]).getTime())) {
      return { valid: false, missing: [`${dateField} (data inválida)`] };
    }
  }

  return { valid: true, missing: [] };
}

async function ingestPersonDocument(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, fileName, mimeType, contentBase64, documentType, category } = payload;

  if (!personId) {
    throw AppError.badRequest('O campo "personId" é obrigatório.', 'DOCUMENT_INGESTION_VALIDATION');
  }
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');

  if (!contentBase64) {
    throw AppError.badRequest('O arquivo enviado está vazio.', 'DOCUMENT_INGESTION_VALIDATION');
  }
  let buffer;
  try {
    buffer = Buffer.from(String(contentBase64), 'base64');
  } catch (err) {
    throw AppError.badRequest('"contentBase64" não é um base64 válido.', 'DOCUMENT_INGESTION_VALIDATION');
  }

  const tenant = { groupId: groupId || person.groupId, companyId: companyId || person.companyId };

  // 1. Antivírus — ANTES de qualquer persistência. Infectado nunca chega a ser gravado
  // (quarentena real, não um aviso depois do fato).
  const antivirusAdapter = await resolveAntivirusAdapter(tenant, transaction);
  const scanResult = await antivirusAdapter.scan(buffer);
  if (!scanResult.clean) {
    throw AppError.unprocessable(
      'Arquivo rejeitado pelo antivírus: assinatura de malware detectada.',
      'DOCUMENT_INGESTION_MALWARE_DETECTED',
      { signature: scanResult.signature }
    );
  }

  // 2. Upload + hash (files.service.js já calcula checksum_sha256 — "hash" do pipeline).
  const file = await uploadFile(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName,
      mimeType,
      contentBase64,
      category: category || 'people-documents',
    },
    actorUserId,
    transaction
  );

  // 3. Classificação — usa o tipo declarado pelo chamador quando informado; sem IA de
  // classificação de verdade contratada ainda, o fallback é "OTHER" (nunca inventa um tipo).
  const classifiedType = documentType ? String(documentType).toUpperCase() : 'OTHER';

  // 4. OCR/IA — dados sugeridos com source_file_id e confidence.
  const ocrAdapter = await resolveOcrAdapter(tenant, transaction);
  const extraction = await ocrAdapter.extract(buffer, classifiedType);

  let verificationStatus;
  let pendingReason = null;

  if (extraction.illegible) {
    // "Documento ilegível gera pendência, não dado inventado" — fields fica vazio.
    verificationStatus = 'PENDING';
    pendingReason = 'Documento ilegível: OCR/IA não conseguiu extrair dados suficientes.';
  } else if (extraction.confidence < CONFIDENCE_THRESHOLD) {
    verificationStatus = 'PENDING';
    pendingReason = `Confiança da extração (${extraction.confidence}) abaixo do mínimo exigido (${CONFIDENCE_THRESHOLD}).`;
  } else {
    const validation = validateCriticalFields(classifiedType, extraction.fields || {});
    if (!validation.valid) {
      verificationStatus = 'PENDING';
      pendingReason = `Campos críticos ausentes ou inválidos: ${validation.missing.join(', ')}.`;
    } else {
      verificationStatus = 'PENDING'; // "IA nunca sobrescreve cadastro existente silenciosamente" — confirmação humana é sempre exigida antes de VERIFIED.
      pendingReason = null;
    }
  }

  const personDocument = await PersonDocument.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId,
      documentType: classifiedType,
      fileId: file.id,
      verificationStatus,
      extractedDataJson: {
        fields: extraction.fields || {},
        sourceFileId: file.id,
        confidence: extraction.confidence,
        illegible: !!extraction.illegible,
      },
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  let pendingTask = null;
  if (pendingReason) {
    pendingTask = await Task.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        assignedToUserId: actorUserId || null,
        title: `Revisar documento ${classifiedType} ilegível/baixa confiança — ${person.legalName}`,
        description: pendingReason,
        relatedEntityType: 'people.persons',
        relatedEntityId: personId,
        status: 'OPEN',
        priority: 'NORMAL',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  return { file, personDocument, extraction, pendingTask };
}

module.exports = { ingestPersonDocument, validateCriticalFields, CONFIDENCE_THRESHOLD };
