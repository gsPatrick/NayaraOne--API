'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrão do livro (INT-P014), usado quando a empresa não configurou. */
const PADROES = Object.freeze({ syncCallTimeoutMs: 5000 });

async function readDomainParams(tenant, transaction) {
  const ms = await getSetting('integration.sync_call_timeout_ms', tenant, transaction, PADROES.syncCallTimeoutMs);
  return { syncCallTimeoutMs: Number.isInteger(ms) && ms >= 100 ? ms : PADROES.syncCallTimeoutMs };
}

module.exports = { PADROES, readDomainParams };
