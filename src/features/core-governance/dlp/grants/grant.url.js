'use strict';

const crypto = require('node:crypto');
const { linkInvalid } = require('./grant.errors');

/**
 * Endereço assinado de uso único (M9-D920 §3.1 e §3.3): `exp` (segundos) e `sig` = HMAC-SHA256 de `tipo|pedido|usuário|exp`, chave derivada do segredo de acesso. O tipo (DOWNLOAD ou
 * PRINT) entra na assinatura, então um endereço de impressão não abre um download. Vale só para quem pediu e nunca passa da validade do pedido; além disso a rota exige login.
 */
let fallbackKey = null;
function key() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (secret) return crypto.createHmac('sha256', secret).update('governance.dlp.grant.url').digest();
  fallbackKey = fallbackKey || crypto.randomBytes(32);
  return fallbackKey;
}
const signature = (kind, jobId, userId, exp) => crypto.createHmac('sha256', key()).update(`${kind}|${jobId}|${userId}|${exp}`).digest('hex');

/** `basePath` = caminho da rota que entrega (sem a query). Devolve { url, expiresAt } com o instante arredondado ao segundo. */
function signGrantUrl({ kind, jobId, userId, basePath, expiresAt }) {
  const exp = Math.floor(new Date(expiresAt).getTime() / 1000);
  return { url: `${basePath}?exp=${exp}&sig=${signature(kind, jobId, userId, exp)}`, expiresAt: new Date(exp * 1000) };
}

function verifyGrantUrl({ kind, jobId, userId, exp, sig, now }) {
  const expNumber = /^\d{1,12}$/.test(String(exp)) ? Number(exp) : NaN;
  const given = Buffer.from(String(sig || ''), 'utf8');
  const wanted = Buffer.from(Number.isFinite(expNumber) ? signature(kind, jobId, userId, expNumber) : '', 'utf8');
  if (!Number.isFinite(expNumber) || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted) || expNumber * 1000 <= now.getTime()) throw linkInvalid();
}

module.exports = { signGrantUrl, verifyGrantUrl };
