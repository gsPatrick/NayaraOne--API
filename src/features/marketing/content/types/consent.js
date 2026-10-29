'use strict';

const { resolveConsent } = require('../../../people/personConsents.service');
const { readPostSalePurpose } = require('./settings');
const { DEFINITIONS } = require('./definitions');

/**
 * M9-D409 — POST_SALE "só com consentimento": a pessoa precisa ter OPT_IN na finalidade de pós-venda (parâmetro) em ao menos um
 * dos canais privados do tipo, e nenhum OPT_OUT geral (ALL) no canal que vale. O envio em si continua passando pelo canSend.
 */
async function hasPostSaleConsent(personId, tenant, transaction) {
  const purpose = await readPostSalePurpose(tenant, transaction);
  for (const channel of DEFINITIONS.POST_SALE.allowedChannels) {
    const [specific, general] = await Promise.all([resolveConsent(personId, channel, purpose, transaction), resolveConsent(personId, channel, 'ALL', transaction)]);
    if (general && general.status === 'OPT_OUT') continue;
    if (specific && specific.status === 'OPT_IN') return true;
  }
  return false;
}

module.exports = { hasPostSaleConsent };
