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
