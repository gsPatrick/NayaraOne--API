'use strict';

const crypto = require('node:crypto');
const { keyUnavailable } = require('./tracking.errors');

/**
 * M9-D431 — assinaturas dos links e do token `r`, com a chave do COFRE (SecretStore, M9-D202): uma chave por empresa em
 * `company/<id>/marketing/tracking-hmac`, criada na primeira necessidade. Nunca lê .env e nunca devolve a chave.
 * Link: signature = HMAC-SHA256(short_code + target_url). Token r: `v1.<messageId>.<HMAC-SHA256("r1:" + linkId + ":" + messageId)>`,
 * que contém só o id da mensagem (a assinatura amarra o token a ESTE link).
 */
const keyRef = (companyId) => `company/${companyId}/marketing/tracking-hmac`;

async function loadKey(companyId) {
  const { getSecretStore } = require('../../../features/integrations/secrets');
  try {
    const store = getSecretStore();
    try {
      return (await store.get(keyRef(companyId))).value.reveal();
    } catch (err) {
      if (err.code !== 'INTEGRATION_SECRET_NOT_FOUND') throw err;
      await store.put(keyRef(companyId), crypto.randomBytes(32).toString('hex'), {});
      return (await store.get(keyRef(companyId))).value.reveal();
    }
  } catch (err) {
    throw keyUnavailable();
  }
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function signLink(companyId, shortCode, targetUrl) {
  return hmac(await loadKey(companyId), `${shortCode}${targetUrl}`);
}

async function verifyLink(companyId, link) {
  return safeEqual(await signLink(companyId, link.short_code, link.target_url), link.signature);
}

async function signMessageToken(companyId, linkId, messageId) {
  return `v1.${messageId}.${hmac(await loadKey(companyId), `r1:${linkId}:${messageId}`)}`;
}

/** Devolve o id da mensagem se o token é válido para o link; senão null (nunca lança: token ruim = clique anônimo). */
async function verifyMessageToken(companyId, linkId, token) {
  const m = /^v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(String(token || ''));
  if (!m) return null;
  const expected = hmac(await loadKey(companyId), `r1:${linkId}:${m[1]}`);
  return safeEqual(expected, m[2]) ? m[1] : null;
}

module.exports = { keyRef, signLink, verifyLink, signMessageToken, verifyMessageToken };
