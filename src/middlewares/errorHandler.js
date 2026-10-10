'use strict';

const AppError = require('../utils/AppError');
const { failure } = require('../utils/httpResponse');
const logger = require('../utils/logger');

/**
 * Middleware de erro global do Express — único ponto que traduz qualquer
 * exceção (operacional ou não) em resposta HTTP padronizada.
 * Deve ser o último middleware montado em app.js.
 *
 * FIX TEC-13 (homologação 10/09/2026): antes só logava em dev, e como texto livre. Agora todo
 * erro (esperado ou não) vira um log estruturado com correlationId + rota, sempre — em
 * produção também, porque é exatamente lá que se precisa investigar um incidente depois.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isProduction = process.env.NODE_ENV === 'production';
  const context = { correlationId: req.correlationId, method: req.method, path: req.originalUrl };

  if (err instanceof AppError) {
    logger.warn({ ...context, code: err.code, statusCode: err.statusCode }, `[AppError] ${err.code}: ${err.message}`);
    return failure(res, {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  // Erros de validação/otimista do Sequelize viram 409/400 amigáveis.
  if (err && err.name === 'SequelizeOptimisticLockError') {
    return failure(res, {
      statusCode: 409,
      code: 'OPTIMISTIC_LOCK_CONFLICT',
      message: 'O registro foi modificado por outra operação concorrente. Recarregue e tente novamente.',
    });
  }

  if (err && err.name === 'SequelizeUniqueConstraintError') {
    return failure(res, {
      statusCode: 409,
      code: 'UNIQUE_CONSTRAINT_VIOLATION',
      message: 'Violação de restrição de unicidade.',
      details: err.errors ? err.errors.map((e) => e.message) : undefined,
    });
  }

  // FIX (auditoria E2E de browser, 01/10/2026): um id de rota com formato inválido (ex.:
  // /construction/projects/id-que-nao-existe-123, resultado comum de favoritos velhos ou link
  // direto digitado errado) batia direto no Postgres como SequelizeDatabaseError ("invalid
  // input syntax for type uuid: ..."), caía no catch-all abaixo e virava 500 com a mensagem
  // crua do Postgres em INGLÊS exibida ao usuário — um 404/400 amigável é o esperado aqui, não
  // um erro interno (não é uma falha do servidor, é um identificador que o usuário passou).
  if (err && err.name === 'SequelizeDatabaseError' && /invalid input syntax for type uuid/i.test(err.message || '')) {
    return failure(res, {
      statusCode: 400,
      code: 'INVALID_ID_FORMAT',
      message: 'O identificador informado não é válido.',
    });
  }

  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 2): quantidade/valor acima da precisão da
  // coluna DECIMAL (ex.: "999999" num campo DECIMAL(9,6), que só comporta 3 dígitos inteiros)
  // batia no Postgres como "numeric field overflow" e vazava cru pro usuário — mesma classe de
  // vazamento de erro de infraestrutura já corrigida acima pra UUID inválido.
  if (err && err.name === 'SequelizeDatabaseError' && /numeric field overflow/i.test(err.message || '')) {
    return failure(res, {
      statusCode: 400,
      code: 'VALUE_TOO_LARGE',
      message: 'O valor informado é grande demais para este campo.',
    });
  }

  // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): upload de arquivo
  // acima do limite do body parser (`express.json({ limit: '28mb' })` em app.js) é interceptado
  // ANTES de chegar no check limpo de MAX_BYTES em files.service.js, batendo como
  // PayloadTooLargeError cru e vazando "request entity too large" com 500 INTERNAL_ERROR em vez
  // de um 400 amigável — mesma classe de vazamento de erro de infraestrutura já corrigida acima.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return failure(res, {
      statusCode: 400,
      code: 'FILE_UPLOAD_TOO_LARGE',
      message: 'O arquivo enviado é grande demais.',
    });
  }

  if (err && err.name === 'SequelizeValidationError') {
    return failure(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Dados inválidos.',
      details: err.errors ? err.errors.map((e) => e.message) : undefined,
    });
  }

  logger.error({ ...context, err: { message: err?.message, name: err?.name, stack: err?.stack } }, '[UnhandledError]');

  return failure(res, {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: isProduction ? 'Erro interno do servidor.' : err && err.message ? err.message : 'Erro interno do servidor.',
  });
}

module.exports = errorHandler;
