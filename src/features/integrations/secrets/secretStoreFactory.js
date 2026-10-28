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

/** Boot: em PRODUÇÃO sem driver (ou com sandbox/driver inválido) a API não sobe. Fora dela, só valida o que foi configurado. */
function assertSecretStoreAtBoot(env = process.env) {
  const producao = getServerEnvironment(env) === 'PRODUCTION';
  if (!env.SECRET_STORE_DRIVER) {
    if (producao) throw storeNotConfigured();
    return;
  }
  const store = buildSecretStoreFromEnv(env);
  if (producao && env.SECRET_STORE_DRIVER === 'http-vault' && env.SECRET_STORE_VAULT_MODE === 'sandbox') {
    throw storeConfig('o cofre sandbox em memória não é permitido em produção.');
  }
  assertStoreShape(store);
}

module.exports = { buildSecretStoreFromEnv, getSecretStore, setSecretStoreForTests, assertSecretStoreAtBoot };
