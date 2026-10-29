'use strict';

const { AiProviderError, KINDS } = require('../providers.errors');

const FALHA = /\[\[FALHA:([A-Z_]+)\]\]/;

/** `[[FALHA:TIMEOUT|RATE_LIMIT|UNAVAILABLE|AUTH|VALIDATION|SAFETY_BLOCKED|UNKNOWN]]` no último user: o sandbox falha como o fornecedor falharia. */
function failureFixture(entrada, providerCode) {
  const m = FALHA.exec(entrada);
  return m && KINDS.includes(m[1]) ? new AiProviderError(m[1], { providerCode, upstreamCode: 'SANDBOX_FIXTURE' }) : null;
}

module.exports = { failureFixture };
