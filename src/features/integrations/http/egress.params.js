'use strict';

const { getSetting } = require('../../settings/settings.service');
const { MODES } = require('./egressPolicy');

/** Modo de saída configurado pela empresa ('enforce' | 'log'), ou null quando ela não configurou (vale o padrão do ambiente da conexão). */
async function readEgressParams(tenant, transaction) {
  const mode = await getSetting('integration.egress.mode', tenant, transaction, null);
  return { mode: MODES.includes(mode) ? mode : null };
}

module.exports = { readEgressParams };
