'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parsePrivateHosts } = require('./privateHosts.settings');

/** Hosts exatos de rede própria que a empresa liberou para o fornecedor `providerCode` (vazio = nenhum, a política padrão vale). */
async function readPrivateHosts(providerCode, tenant, transaction) {
  const texto = await getSetting('integration.egress.private_hosts', tenant, transaction, '');
  const mapa = typeof texto === 'string' && texto.trim() ? (parsePrivateHosts(texto) || {}) : {};
  return mapa[String(providerCode || '').toLowerCase()] || [];
}

module.exports = { readPrivateHosts };
