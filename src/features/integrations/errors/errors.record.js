'use strict';

const { Op } = require('sequelize');
const AppError = require('../../../utils/AppError');
const { sequelize, IntegrationError } = require('../../../models');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { SOURCES, ERROR_CLASSES, SEVERITIES, MESSAGE_MAX } = require('./errors.constants');
const { sanitizeText, sanitizePayload } = require('./sanitizeForError');
const { readErrorParams } = require('./errors.params');
const { severityFor, maxSeverity } = require('./errors.severity');

/** Severidade pela regra da classe (M9-D207); quem tem a gravidade medida por fora (auditoria de dependências, M9-D248) a informa em `severity`. */
const gravidade = (d, attempts, params) => (SEVERITIES.includes(d.severity) ? d.severity : severityFor({ ...d, attempts, exhaustedAttempts: params.exhaustedAttempts }));

const invalido = (msg) => AppError.badRequest(msg, 'INTEGRATION_ERROR_INVALID');

function validar(ctx, d) {
  if (!ctx || !ctx.companyId) {
    throw AppError.badRequest('Erro de integração exige a empresa: sem empresa identificada não se grava linha.', 'INTEGRATION_ERROR_COMPANY_REQUIRED');
  }
  if (!ctx.groupId) throw AppError.badRequest('Erro de integração exige o grupo.', 'INTEGRATION_ERROR_COMPANY_REQUIRED');
  if (!SOURCES.includes(d.source)) throw invalido(`Origem inválida. Use: ${SOURCES.join(', ')}.`);
  if (!ERROR_CLASSES.includes(d.errorClass)) throw invalido(`Classe de erro inválida. Use: ${ERROR_CLASSES.join(', ')}.`);
}

/** Serializa as gravações do mesmo grupo (conexão, código, referência) para que a contagem não perca incrementos. */
async function travarGrupo(ctx, d, transaction) {
  const chave = `${ctx.companyId}|${d.connectionId || ''}|${d.errorCode}|${d.sourceRefId || ''}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:chave))', { replacements: { chave }, transaction });
}

async function acharGrupoAberto(ctx, d, params, transaction) {
  const where = {
    companyId: ctx.companyId, status: 'OPEN', errorCode: d.errorCode, connectionId: d.connectionId || null, financingCaseId: d.sourceRefId || null,
  };
  // Sem referência de origem, agrupa por janela (padrão 10 min); com referência o grupo vale enquanto estiver OPEN.
  if (!d.sourceRefId) where.created_at = { [Op.gte]: new Date(Date.now() - params.groupWindowMin * 60 * 1000) };
  return IntegrationError.findOne({ where, order: [['created_at', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
}

/**
 * recordError — grava (ou agrupa) uma falha de integração. `data`: providerCode, source, errorClass, errorCode, message
 * (já em português), connectionId, sourceRefId, operation, payload (objeto bruto: SEMPRE sanitizado aqui), allowlist,
 * payloadHash (para quem tem o hash do corpo original), httpStatus, attempts, dangerous, correlationId.
 */
async function recordError(ctx, data, transaction) {
  const d = {
    ...data,
    errorCode: (typeof data.errorCode === 'string' && data.errorCode ? data.errorCode : 'INTEGRATION_FAILED').slice(0, 64),
  };
  validar(ctx, d);
  const params = await readErrorParams(ctx, transaction);
  await travarGrupo(ctx, d, transaction);

  const existente = await acharGrupoAberto(ctx, d, params, transaction);
  if (existente) {
    const attempts = existente.attempts + 1;
    const severity = maxSeverity(existente.severity, gravidade(d, attempts, params));
    await existente.update({ attempts, severity, httpStatus: d.httpStatus ?? existente.httpStatus }, { transaction });
    return existente;
  }

  const attempts = Number.isInteger(d.attempts) && d.attempts >= 1 ? d.attempts : 1;
  const saneado = d.payload !== undefined && d.payload !== null ? sanitizePayload(d.payload, { allowlist: d.allowlist }) : null;
  return IntegrationError.create(
    {
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      connectionId: d.connectionId || null,
      providerCode: String(d.providerCode || 'desconhecido').slice(0, 48),
      source: d.source,
      financingCaseId: d.sourceRefId || null,
      operation: d.operation ? String(d.operation).slice(0, 40) : null,
      errorClass: d.errorClass,
      errorCode: d.errorCode,
      severity: gravidade(d, attempts, params),
      message: sanitizeText(d.message || 'Falha na integração.', MESSAGE_MAX),
      sanitizedPayload: saneado ? saneado.sanitized : null,
      payloadHash: d.payloadHash || (saneado ? saneado.hash : null),
      httpStatus: Number.isInteger(d.httpStatus) ? d.httpStatus : null,
      attempts,
      correlationId: String(d.correlationId || getCurrentCorrelationId() || '').slice(0, 64) || null,
    },
    { transaction }
  );
}

module.exports = { recordError };
