'use strict';

const crypto = require('node:crypto');

/**
 * impactToken (M9-D852 §3.1): prova de que o usuário viu o impacto que será executado. Formato `<payload base64url>.<assinatura HMAC-SHA256>`;
 * o payload amarra ação, registro, empresa e usuário ao hash do impacto, com validade (padrão 10 minutos, parâmetro
 * `governanca.acoes.impacto_validade_min`). A chave é derivada do segredo de acesso do servidor (nada novo em arquivo versionado).
 */
function key() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_ACCESS_SECRET ausente.'), { code: 'JWT_CONFIG_MISSING' });
  return crypto.createHmac('sha256', secret).update('m9d852:impact-token').digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (payload) => b64(crypto.createHmac('sha256', key()).update(payload).digest());

function sign({ actionKey, resourceId, companyId, userId }, impact, { ttlMinutes = 10, now = Date.now() } = {}) {
  const hashFn = require('./impact.shape').hash;
  const payload = b64(JSON.stringify({ k: actionKey, r: resourceId || null, c: companyId, u: userId, h: hashFn(impact), e: now + ttlMinutes * 60_000 }));
  return `${payload}.${mac(payload)}`;
}

/** { ok:true, impactHash } ou { ok:false, reason: MALFORMED | SIGNATURE | BINDING | EXPIRED }. */
function verify(token, { actionKey, resourceId, companyId, userId }, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.split('.').length !== 2) return { ok: false, reason: 'MALFORMED' };
  const [payload, signature] = token.split('.');
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'SIGNATURE' };
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_e) { return { ok: false, reason: 'MALFORMED' }; }
  if (data.k !== actionKey || (data.r || null) !== (resourceId || null) || data.c !== companyId || data.u !== userId) return { ok: false, reason: 'BINDING' };
  if (!(data.e > now)) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, impactHash: data.h };
}

module.exports = { sign, verify };
