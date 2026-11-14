'use strict';

const { Person, PersonDocument, Task } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { uploadFile } = require('../files/files.service');
const { onlyDigits, validateDocumentFormat, assertValidTaxId } = require('./personDocumentFormat.service');
const { readDocumentParams, defaultDocumentParams } = require('./personDocument.settings');
const { resolvePersonDocumentEngines, READING_UNAVAILABLE } = require('./personDocumentEngines');
const { classifyBeforeReading, confirmWithText } = require('./personDocumentClassifier');
const { nextVersionNo } = require('./personDocuments.service');

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

// Padrões (comportamento anterior): os valores vigentes são parâmetros da empresa (personDocument.settings.js, CAD-05 / DI-M3PE-6).
const DEFAULT_PARAMS = defaultDocumentParams();
const CONFIDENCE_THRESHOLD = DEFAULT_PARAMS.confiancaMinima;
// Campos "críticos" por tipo de documento — Caderno: "CPF/CNPJ, nome, renda, conta e datas críticas exigem validação antes de persistir
// quando não houver fonte confiável estruturada." O mapa vigente é o parâmetro people.documentos.campos_criticos.
const CRITICAL_FIELDS_BY_TYPE = DEFAULT_PARAMS.camposCriticos;

function validateCriticalFields(documentType, fields, camposCriticos = CRITICAL_FIELDS_BY_TYPE) {
  const requiredFields = camposCriticos[documentType] || [];
  const missing = requiredFields.filter((field) => fields[field] === undefined || fields[field] === null || fields[field] === '');
  if (missing.length > 0) {
    return { valid: false, missing };
  }

  if (fields.taxId) {
    // Lança AppError (400 formato, 422 dígito verificador) — fail fast, nunca persiste CPF/CNPJ malformado ou com dígito verificador
    // errado sugerido pela IA como se fosse confirmado (M3-01: a mesma regra do cadastro).
    const digits = onlyDigits(String(fields.taxId));
    validateDocumentFormat(digits.length === 14 ? 'CNPJ' : 'CPF', digits);
    assertValidTaxId(digits.length === 14 ? 'PJ' : 'PF', digits);
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

/**
 * Motivo de pendência de revisão de uma leitura (null quando a leitura está completa). Usado no envio do documento e na
 * troca do arquivo (personDocumentReplacement.service.js): o arquivo novo passa pela mesma régua. `params` = parâmetros da empresa.
 */
function reviewPendingReason(extraction, documentType, params = DEFAULT_PARAMS) {
  if (extraction.unavailable) return 'Leitura automática indisponível neste servidor: confira os dados no documento original.';
  if (extraction.illegible) return 'Documento ilegível: OCR/IA não conseguiu extrair dados suficientes.';
  if (extraction.confidence < params.confiancaMinima) {
    return `Confiança da extração (${extraction.confidence}) abaixo do mínimo exigido (${params.confiancaMinima}).`;
  }
  const validation = validateCriticalFields(documentType, extraction.fields || {}, params.camposCriticos);
  return validation.valid ? null : `Campos críticos ausentes ou inválidos: ${validation.missing.join(', ')}.`;
}

/** Pendência de revisão manual do documento (core.tasks polimórfica, vinculada à pessoa). */
function openReviewTask({ groupId, companyId, personId, actorUserId, title, reason }, transaction) {
  return Task.create(
    {
      groupId,
      companyId,
      assignedToUserId: actorUserId || null,
      title,
      description: reason,
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
  const params = await readDocumentParams(tenant, transaction);
  const engines = resolvePersonDocumentEngines(params); // laboratório só em teste ou com o parâmetro ligado (DI-M3PE-6)

  // 1. Antivírus — ANTES de qualquer persistência. Infectado nunca chega a ser gravado
  // (quarentena real, não um aviso depois do fato).
  const scanResult = await engines.antivirus.scan(buffer);
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

  // 3. Classificação (personDocumentClassifier.js): tipo declarado e nome do arquivo antes da leitura, confirmado pelo texto do documento.
  const previa = classifyBeforeReading({ documentType, fileName }, params.classificacao);

  // 4. OCR/IA — dados sugeridos com source_file_id e confidence. Sem motor de leitura: nenhum dado, pendência.
  const extraction = engines.leitor ? await engines.leitor.extract(buffer, previa.tipo) : READING_UNAVAILABLE;
  const classification = confirmWithText(previa, extraction.text, params.classificacao);
  const classifiedType = classification.tipo;

  // "IA nunca sobrescreve cadastro existente silenciosamente": a versão nasce sempre PENDING; a confirmação humana é
  // exigida antes de VERIFIED. Ilegível, baixa confiança, campo crítico ausente ou tipo não decidido abrem pendência de revisão.
  const verificationStatus = 'PENDING';
  const pendingReason = [classification.pendencia, reviewPendingReason(extraction, classifiedType, params)].filter(Boolean).join(' ') || null;

  const personDocument = await PersonDocument.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId,
      documentType: classifiedType,
      fileId: file.id,
      versionNo: await nextVersionNo(personId, classifiedType, transaction),
      verificationStatus,
      extractedDataJson: {
        fields: extraction.fields || {},
        sourceFileId: file.id,
        confidence: extraction.confidence,
        illegible: !!extraction.illegible,
        extractionMeta: extraction.raw || null,
        classification: { ...classification, pendencia: classification.pendencia || null },
        engines: engines.motores,
      },
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const pendingTask = pendingReason
    ? await openReviewTask({ ...tenant, personId, actorUserId, title: `Revisar documento ${classifiedType} ilegível/baixa confiança — ${person.legalName}`, reason: pendingReason }, transaction)
    : null;

  await registrarAuditoria(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      actorUserId,
      action: 'people.document.ingest',
      entityType: 'PersonDocument',
      entityId: personDocument.id,
      afterJson: personDocument.toJSON(),
      reason: pendingReason
        ? `Documento ${classifiedType} lido automaticamente; revisão humana pendente: ${pendingReason}`
        : `Documento ${classifiedType} lido automaticamente; aguardando validação humana.`,
    },
    transaction
  );

  return { file, personDocument, extraction, pendingTask };
}

module.exports = { ingestPersonDocument, validateCriticalFields, reviewPendingReason, openReviewTask, CRITICAL_FIELDS_BY_TYPE, CONFIDENCE_THRESHOLD };
