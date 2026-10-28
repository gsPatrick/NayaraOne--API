'use strict';

const AppError = require('../../../utils/AppError');
const { DOMAINS, DOMAIN_CAPABILITIES } = require('./catalog.domains');

function assertDomain(domain) {
  if (!DOMAINS.includes(domain)) {
    throw AppError.unprocessable('Família de integração inexistente.', 'INTEGRATION_DOMAIN_INVALID', { domain: String(domain ?? ''), allowed: DOMAINS });
  }
}

/** Toda capability do fornecedor precisa existir no contrato da família (INTEGRATION_CAPABILITY_INVALID, 422). */
function assertCapabilitiesForDomain(domain, capabilities) {
  assertDomain(domain);
  const permitidas = DOMAIN_CAPABILITIES[domain];
  const fora = (capabilities || []).filter((c) => !permitidas.includes(c));
  if (fora.length) {
    throw AppError.unprocessable('Capacidade não prevista para esta família.', 'INTEGRATION_CAPABILITY_INVALID', { domain, invalid: fora, allowed: permitidas });
  }
}

module.exports = { assertDomain, assertCapabilitiesForDomain };
