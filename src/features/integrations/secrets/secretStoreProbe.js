'use strict';

const { buildSecretStoreFromEnv, getSecretStore, assertSecretStoreAtBoot } = require('./secretStoreFactory');
const { assertStoreShape } = require('./storeContract');
const { storeUnusable } = require('./secrets.errors');
const { getServerEnvironment } = require('../registry/registry.helpers');

/**
 * Prova de que o cofre de segredos FUNCIONA, não só de que está configurado (verificação K=7, item 7b). Antes o boot só conferia a forma do cofre
 * (assertStoreShape): com SECRET_STORE_DIR sem escrita ou o cofre externo inalcançável a API subia "verde" e o e-mail de campanha falhava em silêncio.
 *  - verifySecretStoreAtBoot: regras de configuração (assertSecretStoreAtBoot) + selfTest do driver (file-mounted grava e lê um canário e abre um segredo já
 *    gravado; http-vault é alcançado com a credencial). Em PRODUÇÃO ou HOMOLOGAÇÃO, cofre inutilizável = erro INTEGRATION_SECRET_STORE_UNUSABLE e a API não sobe.
 *  - gateListenOnSecretStore: no ambiente publicado a porta só abre depois da prova; fora dele (máquina do desenvolvedor, CI) sobe na hora e só registra o estado.
 *  - secretStoreHealth: o estado para o GET /health (status, driver, código, quando), sem caminho, valor, chave nem endereço; refeito no máximo a cada CACHE_MS.
 */
const PROBE_TIMEOUT_MS = 5000;
const CACHE_MS = 30000;
let last = null;

const isPublished = (env) => ['PRODUCTION', 'HOMOLOG'].includes(getServerEnvironment(env));

function raceTimeout(work, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
  return Promise.race([Promise.resolve(work).then((value) => ({ value }), (error) => ({ error })), timeout]).finally(() => clearTimeout(timer));
}

/** Roda o selfTest do cofre com prazo. Nunca lança: devolve o estado. */
async function probeStore(store, { timeoutMs = PROBE_TIMEOUT_MS, clock = () => new Date() } = {}) {
  const started = Date.now();
  const base = { driver: store.driver, checkedAt: clock().toISOString() };
  if (typeof store.selfTest !== 'function') return { ...base, status: 'unusable', code: 'INTEGRATION_SECRET_STORE_UNUSABLE', message: 'o driver não oferece prova de uso (selfTest).' };
  const out = await raceTimeout(store.selfTest(), timeoutMs);
  const latencyMs = Date.now() - started;
  if (out.timedOut) return { ...base, status: 'unusable', latencyMs, code: 'INTEGRATION_SECRET_STORE_UNUSABLE', message: `o cofre não respondeu em ${timeoutMs} ms.` };
  if (out.error) return { ...base, status: 'unusable', latencyMs, code: out.error.code || 'INTEGRATION_SECRET_STORE_UNUSABLE', message: String(out.error.message || '').replace(/^Cofre de segredos configurado mas inutilizável: /, '') };
  return { ...base, status: 'ok', latencyMs };
}

/** Estado do cofre configurado no ambiente `env` (sem lançar). */
async function checkSecretStore(env = process.env, opts = {}) {
  if (!env.SECRET_STORE_DRIVER) return { status: 'not_configured', driver: null, checkedAt: new Date().toISOString() };
  let store;
  try {
    store = buildSecretStoreFromEnv(env);
    assertStoreShape(store);
  } catch (err) {
    return { status: 'invalid', driver: env.SECRET_STORE_DRIVER, code: err.code || 'INTEGRATION_SECRET_STORE_CONFIG', message: err.message, checkedAt: new Date().toISOString() };
  }
  return probeStore(store, opts);
}

/** Boot: regras de configuração e prova de uso. Ambiente publicado com cofre que não funciona -> lança (a API não sobe). Devolve o estado. */
async function verifySecretStoreAtBoot(env = process.env, opts = {}) {
  assertSecretStoreAtBoot(env);
  const state = await checkSecretStore(env, opts);
  last = { ...state, at: Date.now() };
  if (isPublished(env) && state.status !== 'ok') throw storeUnusable(`${state.message || state.status} A API não sobe em ${getServerEnvironment(env) === 'PRODUCTION' ? 'produção' : 'homologação'} sem um cofre que grave e leia.`);
  return state;
}

/**
 * Abre a porta da API conforme o cofre. Publicado: espera a prova; se falhar, registra a mensagem clara e encerra o processo com código 1 (a porta nunca abre).
 * Fora dele: abre na hora e registra o estado. `listen` devolve o servidor. Devolve uma promessa do servidor (ou null se encerrou).
 */
function gateListenOnSecretStore(listen, { env = process.env, log, exit = (code) => process.exit(code), timeoutMs } = {}) {
  const check = verifySecretStoreAtBoot(env, { timeoutMs });
  if (!isPublished(env)) {
    const server = listen();
    check.then((s) => log.info({ secretStore: { status: s.status, driver: s.driver } }, 'Cofre de segredos conferido no boot'))
      .catch((err) => log.warn({ code: err.code }, `Cofre de segredos: ${err.message}`));
    return Promise.resolve(server);
  }
  return check.then(
    (s) => { log.info({ secretStore: { status: s.status, driver: s.driver } }, 'Cofre de segredos conferido no boot: grava e lê'); return listen(); },
    (err) => { log.error({ code: err.code }, `Boot recusado: ${err.message}`); exit(1); return null; },
  );
}

/** Estado do cofre EM USO para o GET /health (sem segredo). Refaz a prova no máximo a cada CACHE_MS. */
async function secretStoreHealth({ now = Date.now(), timeoutMs = 2000 } = {}) {
  if (last && now - last.at < CACHE_MS) return publicView(last);
  let state;
  try {
    state = await probeStore(getSecretStore(), { timeoutMs });
  } catch (err) {
    state = { status: err.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED' ? 'not_configured' : 'invalid', driver: process.env.SECRET_STORE_DRIVER || null, code: err.code, checkedAt: new Date(now).toISOString() };
  }
  last = { ...state, at: now };
  return publicView(last);
}

const publicView = (s) => ({ status: s.status, driver: s.driver || null, checkedAt: s.checkedAt, ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}), ...(s.code ? { code: s.code } : {}) });
const resetSecretStoreHealth = () => { last = null; };

module.exports = { probeStore, checkSecretStore, verifySecretStoreAtBoot, gateListenOnSecretStore, secretStoreHealth, resetSecretStoreHealth, PROBE_TIMEOUT_MS };
