'use strict';

const { CHANNEL_META } = require('../channels');

/**
 * Rotas da implementação real, iguais para os 9 canais (muda só o recurso, de channels.js). O Marketing fala com o gateway do canal configurado na connection do
 * bloco B (config.baseUrl); a tradução para o formato de cada fornecedor mora no gateway/adapter do fornecedor, não no domínio do Marketing.
 */
function endpointsFor(channel, baseUrl) {
  const resource = CHANNEL_META[channel].resource;
  const root = String(baseUrl).replace(/\/+$/, '');
  return {
    create: `${root}/${resource}`,
    byKey: (key) => `${root}/${resource}?idempotency_key=${encodeURIComponent(key)}`,
    item: (ref) => `${root}/${resource}/${encodeURIComponent(ref)}`,
    metrics: (ref) => `${root}/${resource}/${encodeURIComponent(ref)}/metrics`,
    revoke: `${root}/auth/revoke`,
    health: `${root}/health`,
  };
}

module.exports = { endpointsFor };
