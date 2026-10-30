'use strict';

const jwt = require('jsonwebtoken');

/**
 * Validação estrita de JWT (Marco 9, M9-D242 3.2), usada por todo adapter de identidade: o algoritmo do cabeçalho precisa estar na lista permitida
 * (`none` nunca, mesmo que alguém o coloque na lista), a assinatura é conferida com a chave informada, e `iss`, `aud`, `exp` e `nbf` são
 * obrigatórios e conferidos com a tolerância de relógio dada. Erros saem com `code` curto (a camada de cima os traduz para 401 em português).
 */
const ALGORITMOS_CONHECIDOS = Object.freeze(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512']);

const falha = (code, message) => Object.assign(new Error(message), { code });

/** Lista de algoritmos efetiva: só os conhecidos, `none` removido. */
const safeAlgorithms = (lista) => (Array.isArray(lista) ? lista : []).map((a) => String(a).trim()).filter((a) => ALGORITMOS_CONHECIDOS.includes(a));

/** Cabeçalho do JWT sem verificar (para escolher a chave pelo `kid`). Texto que não é JWT: null. */
function peekHeader(token) {
  const decoded = jwt.decode(String(token || ''), { complete: true });
  return decoded && decoded.header ? decoded.header : null;
}

/**
 * `keyOrResolver`: segredo/chave pública ou função (header) -> chave. `opts`: algorithms, issuer, audience, clockToleranceS, now (Date, só testes).
 * Devolve as claims. Lança Error com code: TOKEN_MALFORMED, ALG_NOT_ALLOWED, TOKEN_EXPIRED, TOKEN_NOT_YET_VALID, CLAIM_MISSING:<claim>, CLAIM_MISMATCH:<claim>, SIGNATURE_INVALID.
 */
function verifyJwtStrict(token, keyOrResolver, opts = {}) {
  const header = peekHeader(token);
  if (!header) throw falha('TOKEN_MALFORMED', 'O texto não é um JWT.');
  const permitidos = safeAlgorithms(opts.algorithms);
  if (!header.alg || String(header.alg).toLowerCase() === 'none' || !permitidos.includes(header.alg)) throw falha('ALG_NOT_ALLOWED', 'Algoritmo de assinatura não permitido.');
  const chave = typeof keyOrResolver === 'function' ? keyOrResolver(header) : keyOrResolver;
  if (!chave) throw falha('SIGNATURE_INVALID', 'Chave de assinatura não encontrada.');
  let claims;
  try {
    claims = jwt.verify(token, chave, { algorithms: permitidos, ignoreExpiration: true, ignoreNotBefore: true, clockTimestamp: undefined });
  } catch (err) {
    throw falha('SIGNATURE_INVALID', 'Assinatura inválida.');
  }
  const agora = Math.floor((opts.now instanceof Date ? opts.now.getTime() : Date.now()) / 1000);
  const tol = Math.max(0, Number(opts.clockToleranceS) || 0);
  ['exp', 'nbf', 'iss', 'aud', 'sub'].forEach((c) => { if (claims[c] === undefined || claims[c] === null || claims[c] === '') throw falha(`CLAIM_MISSING:${c}`, `Falta a claim ${c}.`); });
  if (typeof claims.exp !== 'number' || typeof claims.nbf !== 'number') throw falha('TOKEN_MALFORMED', 'exp e nbf precisam ser números.');
  if (claims.exp + tol <= agora) throw falha('TOKEN_EXPIRED', 'Credencial expirada.');
  if (claims.nbf - tol > agora) throw falha('TOKEN_NOT_YET_VALID', 'Credencial ainda não vale.');
  if (opts.issuer && claims.iss !== opts.issuer) throw falha('CLAIM_MISMATCH:iss', 'Emissor diferente do esperado.');
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) throw falha('CLAIM_MISMATCH:aud', 'Público diferente do esperado.');
  }
  return claims;
}

module.exports = { verifyJwtStrict, peekHeader, safeAlgorithms, ALGORITMOS_CONHECIDOS };
