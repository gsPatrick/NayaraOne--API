'use strict';

const { storeConfig } = require('./secrets.errors');

/**
 * Transporte HTTPS do cofre externo (M9-D202 3.1b). Endereço e token do cofre vêm do ambiente do processo
 * (SECRET_STORE_VAULT_URL e SECRET_STORE_VAULT_TOKEN): a ligação ao cofre real é configuração, não código.
 * Sem redirecionamento, com prazo, e sem repassar detalhe de rede a quem chamou.
 */
function createHttpTransport({ baseUrl, token, timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) throw storeConfig('o endereço do cofre externo deve ser HTTPS (SECRET_STORE_VAULT_URL).');
  if (!token) throw storeConfig('credencial de acesso ao cofre externo ausente (SECRET_STORE_VAULT_TOKEN).');
  const base = baseUrl.replace(/\/+$/, '');

  return {
    async request({ method, path, body }) {
      const controle = new AbortController();
      const timer = setTimeout(() => controle.abort(), timeoutMs);
      try {
        const resposta = await fetchImpl(`${base}${path}`, {
          method,
          redirect: 'error',
          signal: controle.signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!resposta.ok) throw Object.assign(new Error('cofre recusou'), { status: resposta.status });
        const texto = await resposta.text();
        return texto ? JSON.parse(texto) : {};
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { createHttpTransport };
