'use strict';

const { purgeExpired } = require('../retention');

/**
 * Retenção dos envios da empresa da sessão: troca o conteúdo por {"redacted":true,"hash":...} depois de
 * `integration.dispatch.payload_retention_days` e apaga o envio CONFIRMED/CANCELLED depois de `retention_days`. Só
 * integration.purge_expired() (M9-D244) faz isso, e é a única função que liga a marca de redação do gatilho de imutabilidade.
 */
async function purgeDispatches(ctx, transaction) {
  const r = await purgeExpired(ctx, transaction, { areas: ['dispatch'] });
  return r.dispatches;
}

module.exports = { purgeDispatches };
