'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrão do parametros.csv (M9-D241): série "A". */
const PADROES = Object.freeze({ rpsSeries: 'A' });

async function readNfseParams(ctx, transaction) {
  const serie = await getSetting('correspondent.nfse.rps_series', ctx, transaction, PADROES.rpsSeries);
  return { rpsSeries: typeof serie === 'string' && /^[A-Za-z0-9]{1,8}$/.test(serie) ? serie : PADROES.rpsSeries };
}

module.exports = { PADROES, readNfseParams };
