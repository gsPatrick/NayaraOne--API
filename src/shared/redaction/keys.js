'use strict';

/** Nomes de chave sensíveis (M9-D246 3.1 a), sem diferenciar maiúsculas e ignorando `-`, `_` e espaços. */
const EXACT = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd', 'senha', 'secret', 'token',
  'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'xapikey', 'clientsecret', 'webhooksecret', 'privatekey',
  'xsignature', 'signature', 'card', 'cardnumber', 'cvv', 'pan', 'mfacode', 'rawbody', 'providerpayload',
]);
// DI-M9R-28: chaves de cifra, mestras, de assinatura e de HMAC (FILES_ENCRYPTION_KEY, MFA_ENCRYPTION_KEY, SECRET_STORE_MASTER_KEY…) e strings de conexão
// também são segredo; `idempotencyKey`, `actionKey`, `sortKey` e afins continuam visíveis.
const SUFFIXES = ['token', 'secret', 'password', 'senha', 'apikey', 'privatekey', 'signature', 'authorization',
  'encryptionkey', 'masterkey', 'signingkey', 'hmackey', 'secretkey', 'databaseurl', 'connectionstring'];

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function isSensitiveKey(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  return EXACT.has(k) || SUFFIXES.some((s) => k.endsWith(s));
}

module.exports = { isSensitiveKey, normalizeKey, SENSITIVE_KEY_NAMES: [...EXACT] };
