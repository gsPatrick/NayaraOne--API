'use strict';

const logger = require('../../../utils/logger');
const { redactDeep } = require('../../../shared/redaction');
const { dropForbidden } = require('./auditSanitizer');
const { currentLogContext } = require('../observability/logContext');

/**
 * safeLogger (M9-D028): logger da NAY sobre src/utils/logger.js. Antes de chegar ao pino, o objeto perde as chaves de conteúdo
 * bruto (prompt, documento, resposta do provider, embeddings, cabeçalhos) e passa pela biblioteca única de redaction de M9-D246
 * (chaves sensíveis como authorization, apiKey, secret, token, password, e padrões de valor). Nenhuma regra de detecção própria.
 */
function sanitize(value) {
  return redactDeep(dropForbidden(value));
}

/**
 * M9-D047: todo log da NAY carrega `correlationId` e `runId` (null quando não há). O que o chamador informou vale; senão vale o do run em
 * curso (contexto assíncrono) e, fora de um run, o correlationId da requisição.
 */
function withContext(fields) {
  const ctx = currentLogContext();
  return { ...fields, correlationId: fields.correlationId || ctx.correlationId, runId: fields.runId || ctx.runId };
}

function emit(level, first, message) {
  if (first instanceof Error) return logger[level](withContext(sanitize({ err: first })), message === undefined ? undefined : sanitize(message));
  if (first !== null && typeof first === 'object') return logger[level](withContext(sanitize(first)), message === undefined ? undefined : sanitize(message));
  return logger[level](withContext({}), sanitize(first));
}

const safeLogger = {
  sanitize,
  debug: (first, message) => emit('debug', first, message),
  info: (first, message) => emit('info', first, message),
  warn: (first, message) => emit('warn', first, message),
  error: (first, message) => emit('error', first, message),
};

module.exports = { safeLogger };
