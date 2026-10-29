'use strict';

const crypto = require('crypto');
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { enqueue } = require('../dispatch/enqueue/dispatch.service');
const { assertNoPersonalData } = require('./analytics.pii');
const { errorToEvent } = require('./analytics.errorEvent');

const DOMAIN = 'ANALYTICS';

/**
 * Entrega assíncrona de métrica ou evento (M9-D243 3.1): um envio SAFE da família ANALYTICS (criticidade LOW) enfileirado na transação
 * do chamador, dentro de um savepoint. Falha de qualquer natureza (sem connection ativa, pedido inválido, banco) NUNCA chega ao fluxo de
 * negócio: a emissão devolve { emitted:false, reason } e a transação do chamador segue intacta. A única recusa que sobe é o dado
 * pessoal (422 INTEGRATION_ANALYTICS_PII_BLOCKED), que é erro de quem chama e é checado antes de gravar.
 */
async function emit(ctx, operation, payload, transaction) {
  try {
    const recibo = await sequelize.transaction({ transaction }, (savepoint) => enqueue({
      companyId: ctx.companyId, userId: ctx.userId || null, domain: DOMAIN, operation, payload,
      // Cada emissão é um fato novo: duas métricas iguais no mesmo instante não são a mesma intenção.
      idempotencyKey: `${operation}:${crypto.randomUUID()}`, transaction: savepoint,
    }));
    return { emitted: true, dispatchId: recibo.dispatchId };
  } catch (err) {
    logger.warn({ operation, code: err.code, companyId: ctx.companyId }, 'Emissão de analytics descartada sem afetar o fluxo de negócio');
    return { emitted: false, reason: err.code || 'INTEGRATION_ANALYTICS_FAILED' };
  }
}

/** emitMetric(ctx, { name, value, tags }, transaction) */
function emitMetric(ctx, { name, value, tags }, transaction) {
  assertNoPersonalData({ name, value, tags });
  return emit(ctx, 'emitMetric', { metricName: name, value, tags }, transaction);
}

/** emitEvent(ctx, { name, properties }, transaction) */
function emitEvent(ctx, { name, properties }, transaction) {
  assertNoPersonalData({ name, properties });
  return emit(ctx, 'emitEvent', { eventName: name, properties }, transaction);
}

/** emitError(ctx, err, extra, transaction): erro de aplicação para o destino de monitoramento, com a pilha já redigida. */
function emitError(ctx, err, extra, transaction) {
  return emitEvent(ctx, errorToEvent(err, extra), transaction);
}

module.exports = { emitMetric, emitEvent, emitError };
