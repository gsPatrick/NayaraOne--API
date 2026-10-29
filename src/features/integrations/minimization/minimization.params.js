'use strict';

const { getSetting } = require('../../settings/settings.service');
const { BOOK_CEILING } = require('./purposeLimits');
const { isIntegrationClass, lowest } = require('./classification');
const { maxKey } = require('./minimization.settings');

/** Classificação máxima efetiva da família: o menor entre o teto do livro e o que a empresa configurou. */
async function resolveMaxClassification(domain, tenant, transaction) {
  const ceiling = BOOK_CEILING[domain];
  if (!ceiling) return 'PUBLIC';
  const configured = await getSetting(maxKey(domain), tenant, transaction, ceiling);
  return isIntegrationClass(configured) ? lowest(configured, ceiling) : ceiling;
}

module.exports = { resolveMaxClassification };
