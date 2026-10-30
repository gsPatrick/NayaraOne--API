'use strict';

const jwt = require('jsonwebtoken');
const sandboxKeys = require('../../providers/identity/sandbox/identity.sandbox.keys');
const { localIssuer, localAudience } = require('../../../../shared/identity/localClaims');

/**
 * Ambiente de contrato dos adapters de identidade (M9-D242 + M9-D222): a suíte não abre rede nem banco.
 * - `identity-sandbox`: o token de laboratório é emitido na hora com o par RSA do próprio sandbox (nunca um token fixo que vence).
 * - `identity-local`: o token é assinado com o segredo de laboratório só durante a suíte (HS256, `iss`, `aud`, `nbf` e `exp` do sistema) e a tabela de sessões é um duplo em memória
 *   (a sessão real fica em `core.sessions`, sob a RLS, provada nos testes da M9-D242).
 */
const SEGREDO_DE_CONTRATO = 'segredo-de-contrato-do-token-local-nao-real';

function tokenLocal() {
  const agora = Math.floor(Date.now() / 1000);
  return jwt.sign({ sub: 'usuario-contrato', iss: localIssuer(), aud: localAudience(), iat: agora, nbf: agora, exp: agora + 600 }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256', noTimestamp: true });
}

/** Troca o token do pedido por um válido na hora. */
const prepareSandbox = (pedido) => (pedido.token === undefined ? pedido : { ...pedido, token: sandboxKeys.issueToken({ sub: 'usuario-contrato', email: 'usuario@qa-m9.test', name: 'Usuário de laboratório' }) });
const prepareLocal = (pedido) => (pedido.token === undefined ? pedido : { ...pedido, token: tokenLocal() });

/** Sessões em memória no formato que o adapter local espera do seu "objeto antigo". */
function makeSessionStoreDouble() {
  const revogadas = new Set();
  return {
    async isActive() { return true; },
    async revoke(sessionId) { revogadas.add(String(sessionId)); return { revoked: true }; },
  };
}

function setupLocalSecret() {
  const anterior = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = SEGREDO_DE_CONTRATO;
  return () => { if (anterior === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = anterior; };
}

module.exports = { prepareSandbox, prepareLocal, makeSessionStoreDouble, setupLocalSecret };
