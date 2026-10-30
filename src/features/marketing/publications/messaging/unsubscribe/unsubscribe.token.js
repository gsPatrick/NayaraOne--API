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

async function loadKey(companyId) {
  const { getSecretStore } = require('../../../../integrations/secrets');
  try {
    const store = getSecretStore();
    try {
      return (await store.get(keyRef(companyId))).value.reveal();
    } catch (err) {
      if (err.code !== 'INTEGRATION_SECRET_NOT_FOUND') throw err;
      await store.put(keyRef(companyId), crypto.randomBytes(32).toString('hex'), {});
      return (await store.get(keyRef(companyId))).value.reveal();
    }
  } catch {
    throw mktError(503, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 'Não foi possível assinar o link de descadastro agora.');
  }
}

const mac = (key, companyId, personId, channel) => crypto.createHmac('sha256', key).update(`u1:${companyId}:${personId}:${channel}`, 'utf8').digest('hex');

async function signUnsubscribeToken({ companyId, personId, channel }) {
  const ch = String(channel).toUpperCase();
  return `v1.${companyId}.${personId}.${ch}.${mac(await loadKey(companyId), companyId, personId, ch)}`;
}

/** { companyId, personId, channel } se o token é autêntico; senão null (nunca lança: token ruim é "link inválido"). */
async function verifyUnsubscribeToken(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const [, companyId, personId, channel, given] = m;
  const expected = mac(await loadKey(companyId), companyId, personId, channel.toUpperCase());
  const a = Buffer.from(expected); const b = Buffer.from(given.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { companyId, personId, channel: channel.toUpperCase() } : null;
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken, keyRef };
