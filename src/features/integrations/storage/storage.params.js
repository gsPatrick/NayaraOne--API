'use strict';

const { getSetting } = require('../../settings/settings.service');
const defaults = require('../providers/storage/storage.defaults');

const PADROES = Object.freeze({ signedUrlMaxTtlS: defaults.maxTtlSeconds, defaultProvider: 'storage-local-disk', maxObjectBytes: defaults.maxObjectBytes });
const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Parâmetros do armazenamento da empresa, com o padrão do parametros.csv quando não configurados. */
async function readStorageParams(tenant, transaction) {
  const [ttl, provider, max] = await Promise.all([
    getSetting('integration.storage.signed_url_max_ttl_s', tenant, transaction, PADROES.signedUrlMaxTtlS),
    getSetting('integration.storage.default_provider', tenant, transaction, PADROES.defaultProvider),
    getSetting('integration.storage.max_object_bytes', tenant, transaction, PADROES.maxObjectBytes),
  ]);
  return {
    signedUrlMaxTtlS: inteiro(ttl, PADROES.signedUrlMaxTtlS, 30),
    defaultProvider: ['storage-local-disk', 'storage-sandbox'].includes(provider) ? provider : PADROES.defaultProvider,
    maxObjectBytes: inteiro(max, PADROES.maxObjectBytes, 1024),
  };
}

module.exports = { readStorageParams, PADROES };
