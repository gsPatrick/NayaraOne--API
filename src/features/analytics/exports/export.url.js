'use strict';

/**
 * M9-D701 (3.4) — endereço assinado de uso curto: `exp` (instante em segundos) e `sig` = HMAC-SHA256 de `jobId|usuário|exp`. A chave é derivada do segredo
 * de acesso (sem variável nova). Sem `JWT_ACCESS_SECRET` o endereço NÃO é assinado nem verificado: falha explícita (500 INTERNAL_ERROR, como o resto
 * da API que exige o segredo), nunca uma chave aleatória do processo, que faria o link de uma instância não valer em outra. O endereço só vale para o usuário que pediu a exportação e até `exp`
 * (`analytics.export.url_minutos`, sem passar da validade do arquivo).
 */
const crypto = require('node:crypto');
const AppError = require('../../../utils/AppError');
const { invalidLink } = require('./export.errors');

function urlKey() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw AppError.internal('Variável de ambiente obrigatória ausente: JWT_ACCESS_SECRET.', 'INTERNAL_ERROR');
  return crypto.createHmac('sha256', secret).update('analytics.export.url').digest();
}

const signature = (jobId, userId, exp) => crypto.createHmac('sha256', urlKey()).update(`${jobId}|${userId}|${exp}`).digest('hex');

/** { url, expiresAt } — `now` e `fileExpiresAt` são Date; o endereço nunca vive mais que o arquivo. */
function signDownloadUrl({ jobId, userId, now, urlMinutes, fileExpiresAt }) {
  const byUrl = now.getTime() + urlMinutes * 60000;
  const end = Math.min(byUrl, new Date(fileExpiresAt).getTime());
  const exp = Math.floor(end / 1000);
  return { url: `/v1/analytics/exports/${jobId}/file?exp=${exp}&sig=${signature(jobId, userId, exp)}`, expiresAt: new Date(exp * 1000) };
}

/** Lança 403 ANALYTICS_EXPORT_LINK_INVALID se a assinatura não bate, o usuário é outro ou o prazo passou. */
function verifyDownloadUrl({ jobId, userId, exp, sig, now }) {
  const expNumber = /^\d{1,12}$/.test(String(exp)) ? Number(exp) : NaN;
  const given = Buffer.from(String(sig || ''), 'utf8');
  const wanted = Buffer.from(Number.isFinite(expNumber) ? signature(jobId, userId, expNumber) : '', 'utf8');
  if (!Number.isFinite(expNumber) || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted) || expNumber * 1000 <= now.getTime()) throw invalidLink();
}

module.exports = { signDownloadUrl, verifyDownloadUrl };
