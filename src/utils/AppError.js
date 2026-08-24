'use strict';

/**
 * Erro operacional padronizado da aplicação.
 * `statusCode` mapeia para o código HTTP de resposta; `code` é um identificador
 * estável de erro (usado por clientes/logs), independente da mensagem textual.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, code = 'BAD_REQUEST', details) {
    return new AppError(message, 400, code, details);
  }

  static unauthorized(message = 'Não autenticado.', code = 'UNAUTHORIZED', details) {
    return new AppError(message, 401, code, details);
  }

  static forbidden(message = 'Acesso negado.', code = 'FORBIDDEN', details) {
    return new AppError(message, 403, code, details);
  }

  static notFound(message = 'Recurso não encontrado.', code = 'NOT_FOUND', details) {
    return new AppError(message, 404, code, details);
  }

  static conflict(message, code = 'CONFLICT', details) {
    return new AppError(message, 409, code, details);
  }

  static unprocessable(message, code = 'UNPROCESSABLE_ENTITY', details) {
    return new AppError(message, 422, code, details);
  }

  static internal(message = 'Erro interno.', code = 'INTERNAL_ERROR', details) {
    return new AppError(message, 500, code, details);
  }
}

module.exports = AppError;
