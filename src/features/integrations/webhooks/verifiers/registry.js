'use strict';

const adapterRegistry = require('../../registry/adapterRegistry');

/** Verificadores registrados por código de fornecedor (além do que o próprio adapter declara). Em memória: cada processo registra no boot. */
const registered = new Map();

const valido = (v) => Boolean(v) && typeof v.name === 'string' && typeof v.verify === 'function';

function registerVerifier(providerCode, verifier) {
  if (!valido(verifier)) throw new Error('Verificador de webhook inválido: precisa de name e verify().');
  registered.set(String(providerCode).toLowerCase(), verifier);
}

const unregisterVerifier = (providerCode) => registered.delete(String(providerCode).toLowerCase());

/**
 * verifierFor — o WebhookVerifier do fornecedor (M9-D211 passo 4): primeiro o registrado à mão, depois o que o adapter declara em
 * `webhookVerifier()`. Fornecedor sem verificador devolve null e a rota responde 501: nunca se aceita webhook sem verificação.
 */
function verifierFor(providerCode) {
  const code = String(providerCode || '').toLowerCase();
  if (registered.has(code)) return registered.get(code);
  const adapter = adapterRegistry.instantiate(code);
  const doAdapter = adapter && typeof adapter.webhookVerifier === 'function' ? adapter.webhookVerifier() : null;
  return valido(doAdapter) ? doAdapter : null;
}

module.exports = { registerVerifier, unregisterVerifier, verifierFor };
