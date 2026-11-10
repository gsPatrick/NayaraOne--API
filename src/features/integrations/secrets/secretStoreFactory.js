'use strict';

const { createFileMountedStore } = require('./fileMountedStore');
const { createHttpVaultStore } = require('./httpVaultStore');
const { assertStoreShape } = require('./storeContract');
const { storeNotConfigured, storeConfig } = require('./secrets.errors');
const { getServerEnvironment } = require('../registry/registry.helpers');

/** Seleção do cofre por `SECRET_STORE_DRIVER` (M9-D202 3.1). Nunca cai em .env: sem driver, recusa. */

function buildSecretStoreFromEnv(env = process.env) {
  const driver = env.SECRET_STORE_DRIVER;
  if (driver === 'file-mounted') return createFileMountedStore({ dir: env.SECRET_STORE_DIR, masterKey: env.SECRET_STORE_MASTER_KEY });
  if (driver === 'http-vault') {
    return createHttpVaultStore({
      mode: env.SECRET_STORE_VAULT_MODE, baseUrl: env.SECRET_STORE_VAULT_URL, token: env.SECRET_STORE_VAULT_TOKEN,
      timeoutMs: Number(env.SECRET_STORE_VAULT_TIMEOUT_MS) || undefined,
    });
  }
  throw storeNotConfigured();
}

let instancia = null;
function getSecretStore() {
  if (!instancia) {
    instancia = buildSecretStoreFromEnv();
    assertStoreShape(instancia);
  }
  return instancia;
}
const setSecretStoreForTests = (store) => { instancia = store; };

/**
 * Boot: em ambiente PUBLICADO (PRODUÇÃO ou HOMOLOGAÇÃO) sem driver, ou com o cofre sandbox em memória, a API não sobe. Só no SANDBOX
 * (máquina do desenvolvedor, CI) o cofre é opcional. Homologação sem cofre subia e falhava em silêncio tudo o que assina com chave do
 * cofre (link de descadastro, links rastreados, person_hash): o e-mail de campanha virava FAILED MKT_UNSUBSCRIBE_KEY_UNAVAILABLE.
 * O cofre em memória perde as chaves a cada reinício (descadastro de e-mail antigo deixaria de valer), por isso também fica fora.
 */
function assertSecretStoreAtBoot(env = process.env) {
  const ambiente = getServerEnvironment(env);
  const publicado = ambiente === 'PRODUCTION' || ambiente === 'HOMOLOG';
  const nome = ambiente === 'PRODUCTION' ? 'produção' : 'homologação';
  if (!env.SECRET_STORE_DRIVER) {
    if (publicado) throw storeNotConfigured(`Em ${nome}, defina SECRET_STORE_DRIVER (file-mounted com SECRET_STORE_DIR e SECRET_STORE_MASTER_KEY, ou http-vault).`);
    return;
  }
  const store = buildSecretStoreFromEnv(env);
  if (publicado && env.SECRET_STORE_DRIVER === 'http-vault' && env.SECRET_STORE_VAULT_MODE === 'sandbox') {
    throw storeConfig(`o cofre sandbox em memória não é permitido em ${nome}.`);
  }
  assertStoreShape(store);
}

module.exports = { buildSecretStoreFromEnv, getSecretStore, setSecretStoreForTests, assertSecretStoreAtBoot };
