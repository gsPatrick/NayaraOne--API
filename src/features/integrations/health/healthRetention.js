'use strict';

const { q, SELECT } = require('./healthStore');
const { readHealthParams } = require('./healthParams');

/**
 * Expurgo das janelas vencidas (`integration.health.history_retention_days`, padrão 30). O role de runtime não tem
 * DELETE: quem apaga é a função SECURITY DEFINER `integration.purge_provider_health`, que só enxerga a empresa da
 * sessão e nunca toca a linha atual. M9-D244 chama esta mesma função de `integration.purge_expired()`.
 * Devolve quantas linhas foram removidas.
 */
async function purgeExpiredHealth(ctx, transaction) {
  const { retentionDays } = await readHealthParams(ctx, transaction);
  const rows = await q('SELECT "integration".purge_provider_health(:d) AS removed', { d: retentionDays }, transaction, SELECT);
  return Number(rows[0].removed);
}

module.exports = { purgeExpiredHealth };
