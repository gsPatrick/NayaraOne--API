'use strict';

const AppError = require('../../../utils/AppError');

/** M9-D612 — erros do livro (seção 4 da demanda). Mensagens em português, sem texto de driver. */
const MSG = {
  READ_ONLY: 'Os painéis são somente leitura.',
  WRITE_BLOCKED: 'Bloqueada pelo banco (transação somente leitura); registrado como incidente de segurança.',
  QUERY_TIMEOUT: 'A consulta demorou mais que o permitido. Tente novamente.',
};

/** 405 ANALYTICS_READ_ONLY: método de escrita em rota de leitura. */
function readOnlyMethodError() {
  return new AppError(MSG.READ_ONLY, 405, 'ANALYTICS_READ_ONLY');
}

/** 500 ANALYTICS_WRITE_BLOCKED: o banco recusou uma escrita feita dentro de um GET de BI. */
function writeBlockedError() {
  return new AppError(MSG.WRITE_BLOCKED, 500, 'ANALYTICS_WRITE_BLOCKED');
}

/** 504 ANALYTICS_QUERY_TIMEOUT: a consulta do BI passou do tempo máximo (statement_timeout da transação do GET, M9-D698). */
function queryTimeoutError() {
  return new AppError(MSG.QUERY_TIMEOUT, 504, 'ANALYTICS_QUERY_TIMEOUT');
}

module.exports = { MSG, readOnlyMethodError, writeBlockedError, queryTimeoutError };
