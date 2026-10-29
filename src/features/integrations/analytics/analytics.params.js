'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrão do parametros.csv (INT-P090) quando a empresa não configurou. */
const PADROES = Object.freeze({ dropAfterS: 300 });

async function readAnalyticsParams(ctx, transaction) {
  const dropAfterS = await getSetting('integration.analytics.drop_after_s', ctx, transaction, PADROES.dropAfterS);
  return { dropAfterS: Number.isInteger(dropAfterS) && dropAfterS >= 1 ? dropAfterS : PADROES.dropAfterS };
}

module.exports = { PADROES, readAnalyticsParams };
