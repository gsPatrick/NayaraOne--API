'use strict';

const AppError = require('../../../utils/AppError');
const { SecretValue } = require('./SecretValue');
const { secretNotFound, storeUnavailable, rotationFailed, storeUnusable } = require('./secrets.errors');

const CANARY_REF = 'platform/secret-store/canario';
const { assertValue, assertRef } = require('./storeContract');
const { createSandboxTransport } = require('./vaultTransport.sandbox');
const { createHttpTransport } = require('./vaultTransport.http');

/**
 * Driver `http-vault` (M9-D202 3.1b): cliente de cofre externo sobre um transporte (HTTPS real ou sandbox).
 * Todo erro do cofre vira um erro do projeto sem endereço, token nem corpo: 404 -> não encontrado,
 * 409/422 -> rotação recusada, o resto -> cofre indisponível (503).
 */
function createHttpVaultStore({ mode, transport, baseUrl, token, timeoutMs, clock } = {}) {
  const via = transport || (mode === 'sandbox' ? createSandboxTransport({ clock }) : createHttpTransport({ baseUrl, token, timeoutMs }));
  const caminho = (ref, resto) => `/secrets/${encodeURIComponent(ref)}${resto}`;

  async function chamar(method, path, body) {
    try {
      return await via.request({ method, path, body });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err?.status === 404) throw secretNotFound();
      if (err?.status === 409 || err?.status === 422) throw rotationFailed();
      throw storeUnavailable();
    }
  }

  const entrega = (r) => ({ value: new SecretValue(r.value), version: r.version, expiresAt: r.expiresAt ? new Date(r.expiresAt) : null });

  return {
    driver: 'http-vault',
    /**
     * Prova de uso real (boot e health): o cofre externo responde e aceita a credencial. Lê a referência canário (não precisa existir: 404 = alcançável e
     * autorizado); rede, prazo, 401/403 e 5xx viram INTEGRATION_SECRET_STORE_UNUSABLE. Nunca grava.
     */
    async selfTest() {
      try {
        await via.request({ method: 'GET', path: caminho(CANARY_REF, '/meta') });
      } catch (err) {
        if (err?.status === 404) return { ok: true };
        throw storeUnusable(`o cofre externo não respondeu ou recusou a credencial (${err?.status ? `HTTP ${err.status}` : (err?.name || 'rede')}); confira SECRET_STORE_VAULT_URL e SECRET_STORE_VAULT_TOKEN.`);
      }
      return { ok: true };
    },
    async get(ref, { version } = {}) {
      assertRef(ref);
      return entrega(await chamar('GET', caminho(ref, `/versions/${version === undefined || version === null ? 'current' : Number(version)}`)));
    },
    async getAcceptedVersions(ref) {
      assertRef(ref);
      return (await chamar('GET', caminho(ref, '/accepted'))).map(entrega);
    },
    async put(ref, value, { expiresAt = null, candidate = false, graceMs = 0 } = {}) {
      assertRef(ref);
      assertValue(value);
      return (await chamar('POST', caminho(ref, '/versions'), { value, expiresAt, candidate, graceMs })).version;
    },
    async rotate(ref, version, { graceMs = 0 } = {}) {
      assertRef(ref);
      return (await chamar('POST', caminho(ref, '/promote'), { version: Number(version), graceMs })).version;
    },
    async describe(ref) {
      assertRef(ref);
      return chamar('GET', caminho(ref, '/meta'));
    },
    async revoke(ref, version) {
      assertRef(ref);
      await chamar('POST', caminho(ref, '/revoke'), { version: Number(version) });
    },
  };
}

module.exports = { createHttpVaultStore };
