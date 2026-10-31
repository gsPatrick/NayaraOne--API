'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parseProviderHosts } = require('./providerHosts.settings');

/** Hosts a mais que o fornecedor `providerCode` aceita como endereço base, definidos pela empresa (vazio = só os do adaptador). */
async function readProviderHosts(providerCode, tenant, transaction) {
  const texto = await getSetting('integration.egress.provider_hosts', tenant, transaction, '');
  const mapa = typeof texto === 'string' && texto.trim() ? (parseProviderHosts(texto) || {}) : {};
  return mapa[String(providerCode || '').toLowerCase()] || [];
}

module.exports = { readProviderHosts };
