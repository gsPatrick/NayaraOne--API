'use strict';

const { sequelize } = require('../../../../models');
const { recordError } = require('../../errors');
const { publishDispatchEvent, EVENTS } = require('../dispatch.events');
const { authFailed } = require('../dispatch.errors');

const MENSAGENS = Object.freeze({
  VALIDATION: 'O fornecedor recusou os dados do envio: corrija o dado e envie novamente.',
  AUTH: authFailed().message,
  DEAD_LETTER: 'O envio esgotou as tentativas e foi para a fila morta.',
  UNKNOWN: 'Não foi possível confirmar se o fornecedor recebeu o envio: ele aguarda conferência.',
  EXTERNAL_FAILED: 'O fornecedor informou que a operação não foi concluída: confira o resultado e envie novamente se for o caso.',
  UNKNOWN_UNRESOLVED: 'Não foi possível descobrir se o fornecedor executou a operação depois de várias consultas: confira no extrato ou no painel do fornecedor antes de repetir.',
  RATE_LIMIT_CAP: 'O fornecedor pediu uma espera maior que o limite configurado: o envio espera o limite e a integração merece atenção.',
});

/** Erro de integração do envio (alerta): só classe, código, status e contadores; sem conteúdo do envio e sem texto do fornecedor. */
async function reportDispatchError(ctx, dispatch, { errorClass, errorCode, severity, message, httpStatus }, transaction) {
  return recordError(ctx, {
    providerCode: dispatch.providerCode, connectionId: dispatch.connectionId, source: 'DISPATCH', errorClass, errorCode: errorCode || 'INTEGRATION_FAILED',
    message, operation: dispatch.operation, severity, httpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined, attempts: Math.max(1, dispatch.attempts),
    dangerous: dispatch.criticalityOp === 'DANGEROUS', correlationId: dispatch.correlationId || undefined,
  }, transaction);
}

/** O domínio recebe `integration.dispatch.failed` para corrigir o dado ou acompanhar a fila morta. */
const publishFailed = (ctx, dispatch, extra, transaction) => publishDispatchEvent(ctx, dispatch, EVENTS.FAILED, extra, transaction);

/** Marca a classe FINAL na tentativa (a do adapter pode ter sido refinada pelo motor) e se ela terminou em limite do fornecedor. */
async function annotateAttempt(attemptId, { errorClass, errorCode, rateLimited = false }, transaction) {
  await sequelize.query('UPDATE "integration"."dispatch_attempts" SET error_class = :c, error_code = :k, rate_limited = :r WHERE id = :id', {
    replacements: { id: attemptId, c: errorClass, k: errorCode ? String(errorCode).slice(0, 64) : null, r: rateLimited }, transaction,
  });
}

module.exports = { reportDispatchError, publishFailed, annotateAttempt, MENSAGENS };
