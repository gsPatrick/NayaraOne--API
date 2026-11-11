'use strict';

const { File, OutboxEvent, AuditLog } = require('../../models');
const AppError = require('../../utils/AppError');
const { normalizeOptionalText } = require('./legalText');

/**
 * Origem do prazo (Caderno M5 §15 "Prazo sempre tem source_document/source_event"; Guia §12
 * `if (!input.sourceFileId && !input.sourceEventId) throw new ValidationError('DEADLINE_SOURCE_REQUIRED')`;
 * JUR-TS-008 "Prazo sem origem | Criar crítico | Bloqueado").
 *  - sourceFileId: arquivo da empresa (RLS) e íntegro (com SHA-256 gravado no upload) — o documento que originou o prazo.
 *  - sourceEventId: evento real da empresa — linha de integration.outbox_events ou de audit.audit_log (movimentação).
 *  - sourceDocument / sourceEvent (texto): descrição complementar; sozinhos NÃO bastam (o Guia exige o id).
 * DECISÃO (registrada no relatório da matriz): "compatibilidade com o texto de origem" = os prazos legados que só têm
 * texto continuam válidos e editáveis; o texto pode acompanhar o id. A única criação aceita só com texto é a da
 * contingência do BCP (formulário manual registrado na operação do BCP), via `options.contingencyOrigin`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`"${field}" deve ser o identificador (UUID) do ${field === 'sourceFileId' ? 'arquivo' : 'evento'} de origem.`, 'LEGAL_DEADLINE_VALIDATION');
  }
  return value.toLowerCase();
}

const notFound = () => AppError.badRequest('O documento ou evento de origem não foi encontrado nesta empresa.', 'LEGAL_DEADLINE_SOURCE_NOT_FOUND');

async function resolveEvent(eventId, companyId, transaction) {
  if (await OutboxEvent.findOne({ where: { id: eventId, companyId }, attributes: ['id'], transaction })) return 'OUTBOX_EVENT';
  if (await AuditLog.findOne({ where: { id: eventId, companyId }, attributes: ['id'], transaction })) return 'AUDIT_LOG';
  return null;
}

/** Devolve { sourceFileId, sourceEventId, sourceEventType, sourceDocument, sourceEvent } validados. */
async function resolveDeadlineSource(payload, legalCase, transaction, options = {}) {
  const sourceDocument = normalizeOptionalText(payload.sourceDocument, 'sourceDocument');
  const sourceEvent = normalizeOptionalText(payload.sourceEvent, 'sourceEvent');
  if ((sourceDocument && sourceDocument.length > 255) || (sourceEvent && sourceEvent.length > 255)) {
    throw AppError.badRequest('"sourceDocument" e "sourceEvent" aceitam no máximo 255 caracteres.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const hasFile = payload.sourceFileId !== undefined && payload.sourceFileId !== null && payload.sourceFileId !== '';
  const hasEvent = payload.sourceEventId !== undefined && payload.sourceEventId !== null && payload.sourceEventId !== '';
  if (!hasFile && !hasEvent) {
    if (options.contingencyOrigin && (sourceDocument || sourceEvent)) {
      return { sourceFileId: null, sourceEventId: null, sourceEventType: null, sourceDocument: sourceDocument || null, sourceEvent: sourceEvent || null };
    }
    throw AppError.badRequest(
      'Informe o documento (sourceFileId) ou o evento (sourceEventId) que originou o prazo — todo prazo jurídico precisa de uma origem verificável.',
      'DEADLINE_SOURCE_REQUIRED'
    );
  }
  let sourceFileId = null;
  if (hasFile) {
    sourceFileId = requireUuid(payload.sourceFileId, 'sourceFileId');
    const file = await File.findOne({ where: { id: sourceFileId, companyId: legalCase.companyId }, attributes: ['id', 'checksumSha256'], transaction });
    if (!file) throw notFound();
    if (!file.checksumSha256) throw AppError.badRequest('O arquivo de origem não tem SHA-256 gravado (não é verificável).', 'LEGAL_DEADLINE_SOURCE_NOT_FOUND');
  }
  let sourceEventId = null;
  let sourceEventType = null;
  if (hasEvent) {
    sourceEventId = requireUuid(payload.sourceEventId, 'sourceEventId');
    sourceEventType = await resolveEvent(sourceEventId, legalCase.companyId, transaction);
    if (!sourceEventType) throw notFound();
  }
  return { sourceFileId, sourceEventId, sourceEventType, sourceDocument: sourceDocument || null, sourceEvent: sourceEvent || null };
}

module.exports = { resolveDeadlineSource };
