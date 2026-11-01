'use strict';

const crypto = require('node:crypto');
const { linkInvalid } = require('./export.errors');

/**
 * Endereço assinado do download (M9-D822 §3.1): `exp` (segundos) e `sig` = HMAC-SHA256 de `job|usuário|exp`, chave derivada do segredo de acesso. Vale só para quem pediu e
 * nunca passa da validade do arquivo. Além disso o download exige login (a assinatura sozinha não abre o arquivo).
 */
let fallbackKey = null;
function key() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (secret) return crypto.createHmac('sha256', secret).update('governance.dlp.export.url').digest();
  // R5/R3-L2: sem o segredo de acesso não existe chave efêmera fora do teste (falha fechada, igual ao JWT).
  if (process.env.NODE_ENV !== 'test') throw new Error('JWT_ACCESS_SECRET ausente: endereço assinado indisponível.');
  fallbackKey = fallbackKey || crypto.randomBytes(32);
  return fallbackKey;
}
const signature = (jobId, userId, exp) => crypto.createHmac('sha256', key()).update(`${jobId}|${userId}|${exp}`).digest('hex');

function signDownloadUrl({ jobId, userId, now, urlMinutes, fileExpiresAt }) {
  const end = Math.min(now.getTime() + urlMinutes * 60000, new Date(fileExpiresAt).getTime());
  const exp = Math.floor(end / 1000);
  return { url: `/api/v1/exports/${jobId}/download?exp=${exp}&sig=${signature(jobId, userId, exp)}`, expiresAt: new Date(exp * 1000) };
}

function verifyDownloadUrl({ jobId, userId, exp, sig, now }) {
  const expNumber = /^\d{1,12}$/.test(String(exp)) ? Number(exp) : NaN;
  const given = Buffer.from(String(sig || ''), 'utf8');
  const wanted = Buffer.from(Number.isFinite(expNumber) ? signature(jobId, userId, expNumber) : '', 'utf8');
  if (!Number.isFinite(expNumber) || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted) || expNumber * 1000 <= now.getTime()) throw linkInvalid();
}

module.exports = { signDownloadUrl, verifyDownloadUrl };
