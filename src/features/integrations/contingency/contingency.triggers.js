'use strict';

const { getCurrentHealth } = require('../health/healthQuery');
const { hasAgedQueued } = require('./contingency.queueAge');

/**
 * Gatilhos da contingência de uma connection (M9-D226 3.2), derivados do estado atual: circuito OPEN (D217); connection AUTH_FAILED ou
 * PAUSED; saúde DOWN; envio da fila além de `queue_max_age_h`. (A ausência de connection ACTIVE chega pelo gancho de M9-D201.)
 * Devolve a lista de motivos (vazia = nada a fazer).
 */
async function connectionReasons(ctx, connection, policy, now, transaction) {
  const reasons = [];
  if (connection.status === 'AUTH_FAILED') reasons.push('AUTH_FAILED');
  if (connection.status === 'PAUSED') reasons.push('PAUSED');
  if (connection.status === 'ACTIVE') {
    const saude = await getCurrentHealth(connection.id, ctx, transaction, { now });
    if (saude.circuitState === 'OPEN') reasons.push('CIRCUIT_OPEN');
    if (saude.healthStatus === 'DOWN') reasons.push('HEALTH_DOWN');
  }
  if (await hasAgedQueued(ctx, connection.id, policy.queueMaxAgeH, now, transaction)) reasons.push('QUEUE_AGE_EXCEEDED');
  return reasons;
}

module.exports = { connectionReasons };
