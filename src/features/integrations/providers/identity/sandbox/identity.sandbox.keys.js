'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

/**
 * Chaves do provedor de identidade de laboratório (M9-D242): um par RSA gerado na primeira necessidade, em memória, que assina os tokens que o sandbox emite e
 * que aparece no JWKS. `rotate()` troca o par (o `kid` muda), para provar o cache de JWKS. Nada disso é segredo de produção: o sandbox não tem rede nem conta.
 */
let current = null;
const retired = [];

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `sbx-${crypto.randomBytes(6).toString('hex')}`;
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}

const active = () => { if (!current) current = generate(); return current; };

/** Documento JWKS (apenas a chave pública vigente). */
const jwks = () => ({ keys: [active().jwk] });

/** Troca o par: a chave antiga sai do JWKS. */
function rotate() { retired.push(active().kid); current = generate(); return current.kid; }

/** Emite um token do provedor. `claims` sem iss/aud/exp/nbf recebem os do pedido (`issuer`, `audience`, `expiresInS`, `notBeforeOffsetS`). */
function issueToken(claims = {}, { issuer = 'identity-sandbox', audience = 'nayara-one', expiresInS = 600, notBeforeOffsetS = 0, now = Math.floor(Date.now() / 1000), kid } = {}) {
  const k = active();
  const corpo = { sub: 'sbx-user', iss: issuer, aud: audience, iat: now, nbf: now + notBeforeOffsetS, exp: now + expiresInS, ...claims };
  Object.keys(corpo).forEach((c) => { if (corpo[c] === undefined) delete corpo[c]; });
  return jwt.sign(corpo, k.privateKey, { algorithm: 'RS256', keyid: kid || k.kid, noTimestamp: true });
}

const reset = () => { current = null; retired.length = 0; };

module.exports = { jwks, rotate, issueToken, reset, currentKid: () => active().kid };
