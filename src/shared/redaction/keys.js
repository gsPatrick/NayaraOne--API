'use strict';

/** Nomes de chave sensíveis (M9-D246 3.1 a), sem diferenciar maiúsculas e ignorando `-`, `_` e espaços. */
const EXACT = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd', 'senha', 'secret', 'token',
  'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'xapikey', 'clientsecret', 'webhooksecret', 'privatekey',
  'xsignature', 'signature', 'card', 'cardnumber', 'cvv', 'pan', 'mfacode', 'rawbody', 'providerpayload',
]);
const SUFFIXES = ['token', 'secret', 'password', 'senha', 'apikey', 'privatekey', 'signature', 'authorization'];

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function isSensitiveKey(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  return EXACT.has(k) || SUFFIXES.some((s) => k.endsWith(s));
}

module.exports = { isSensitiveKey, normalizeKey, SENSITIVE_KEY_NAMES: [...EXACT] };
