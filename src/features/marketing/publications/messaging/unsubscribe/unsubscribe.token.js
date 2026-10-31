'use strict';

const crypto = require('node:crypto');
const { mktError } = require('../../../marketing.errors');

/**
 * M9-D429 regra 3 — token assinado do link de descadastro do e-mail, com a chave do COFRE (SecretStore, M9-D202): uma chave por empresa em
 * `company/<id>/marketing/unsubscribe-hmac`, criada na primeira necessidade. Nunca lê .env e nunca devolve a chave. Formato:
 * `v1.<companyId>.<personId>.<channel>.<HMAC-SHA256("u1:" + companyId + ":" + personId + ":" + channel)>`. O token só vale para essa pessoa, essa
 * empresa e esse canal, e não expira: o descadastro tem de funcionar em e-mail antigo.
 */
const keyRef = (companyId) => `company/${companyId}/marketing/unsubscribe-hmac`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_RE = new RegExp(`^v1\\.(${UUID})\\.(${UUID})\\.(EMAIL|WHATSAPP)\\.([0-9a-f]{64})$`, 'i');

const unavailable = () => mktError(503, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 'Não foi possível validar o link de descadastro agora. Tente novamente em instantes.');

/** Última chave lida com sucesso por empresa (só em memória, por `cacheTtlS`, o mesmo `integration.secret.cache_ttl_s` do cofre): caminho degradado quando o cofre cai. */
const lastGood = new Map();
const clearUnsubscribeKeyCache = () => lastGood.clear();

/**
 * Lê a chave da empresa no cofre. `create: true` SÓ para assinar (signUnsubscribeToken): a verificação nunca escreve no cofre, então um token
 * inventado não cria segredo. Cofre fora: usa a última chave lida com sucesso (dentro do TTL); sem ela, 503.
 */
async function loadKey(companyId, { create = false, cacheTtlS = 0, nowMs = Date.now() } = {}) {
  const { getSecretStore } = require('../../../../integrations/secrets');
  try {
    const store = getSecretStore();
    let key;
    try {
      key = (await store.get(keyRef(companyId))).value.reveal();
    } catch (err) {
      if (err.code !== 'INTEGRATION_SECRET_NOT_FOUND') throw err;
      if (!create) return null;
      await store.put(keyRef(companyId), crypto.randomBytes(32).toString('hex'), {});
      key = (await store.get(keyRef(companyId))).value.reveal();
    }
    if (cacheTtlS > 0) lastGood.set(companyId, { key, expiresAtMs: nowMs + cacheTtlS * 1000 });
    return key;
  } catch {
    const hit = lastGood.get(companyId);
    if (!create && hit && nowMs < hit.expiresAtMs) return hit.key;
    throw unavailable();
  }
}

const mac = (key, companyId, personId, channel) => crypto.createHmac('sha256', key).update(`u1:${companyId}:${personId}:${channel}`, 'utf8').digest('hex');

async function signUnsubscribeToken({ companyId, personId, channel }) {
  const ch = String(channel).toUpperCase();
  return `v1.${companyId}.${personId}.${ch}.${mac(await loadKey(companyId, { create: true }), companyId, personId, ch)}`;
}

/** Só o formato do token (sem cofre): { companyId, personId, channel, given } ou null. */
function parseUnsubscribeToken(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  return { companyId: m[1], personId: m[2], channel: m[3].toUpperCase(), given: m[4].toLowerCase() };
}

/** { companyId, personId, channel } se o token é autêntico; senão null (token ruim é "link inválido"). SÓ LÊ o cofre; empresa sem chave = token inválido. */
async function verifyUnsubscribeToken(token, opts = {}) {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return null;
  const key = await loadKey(parsed.companyId, { create: false, ...opts });
  if (!key) return null;
  const a = Buffer.from(mac(key, parsed.companyId, parsed.personId, parsed.channel)); const b = Buffer.from(parsed.given);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { companyId: parsed.companyId, personId: parsed.personId, channel: parsed.channel } : null;
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken, parseUnsubscribeToken, clearUnsubscribeKeyCache, keyRef };
