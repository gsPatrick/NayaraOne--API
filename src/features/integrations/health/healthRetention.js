'use strict';

const { purgeExpired } = require('../retention');

/**
 * Expurgo das janelas vencidas (`integration.health.history_retention_days`, padrão 30). O role de runtime não tem
 * DELETE: quem apaga é integration.purge_expired() (M9-D244), que chama purge_provider_health por dentro, só enxerga a
 * empresa da sessão e nunca toca a linha atual. Devolve quantas linhas foram removidas.
 */
async function purgeExpiredHealth(ctx, transaction) {
  const r = await purgeExpired(ctx, transaction, { areas: ['health'] });
  return Number(r.provider_health);
}

module.exports = { purgeExpiredHealth };
