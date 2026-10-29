'use strict';

const logger = require('../../../../utils/logger');
const AppError = require('../../../../utils/AppError');
const { temporarilyUnavailable } = require('../webhooks.errors');

/**
 * Prazo da rota (M9-D212 3.1): a resposta nunca passa de integration.webhook.response_timeout_ms contados desde a chegada. Estourou o prazo, ou o banco não
 * respondeu: 503 INTEGRATION_WEBHOOK_TEMPORARILY_UNAVAILABLE, e o fornecedor reenvia (o evento, se chegou a ser gravado, volta como duplicate). Erro da própria
 * regra (AppError) passa como está.
 */
async function withIntakeDeadline(startedAt, timeoutMs, fn) {
  const restante = Math.max(1, timeoutMs - (Date.now() - startedAt));
  let timer;
  const prazo = new Promise((_, reject) => { timer = setTimeout(() => reject(temporarilyUnavailable()), restante); });
  try {
    return await Promise.race([fn(), prazo]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err: err.message }, 'webhook.intake.persist.failed');
    throw temporarilyUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withIntakeDeadline };
