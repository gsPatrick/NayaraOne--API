'use strict';

/**
 * M9-D611 (3.1 e 3.6) — filtro canônico, hash e assinatura. `filterHash` = SHA-256 do JSON canônico de { table, filter }; a assinatura é
 * HMAC-SHA256 sobre (empresa, hash) com chave derivada do segredo de acesso do servidor (mesma origem da chave do log de acesso, DI-D611-2),
 * de modo que ninguém forja um filtro mais amplo que o autorizado nem leva um filtro de uma empresa para outra. Sem segredo no servidor a
 * assinatura falha fechada (500). A chave nunca sai daqui.
 *
 * Filtro canônico: { companyId, period?: { from, to } (início inclusivo, fim exclusivo), status?: [..], nature?: [..], equals?: { nome: valor|null } }.
 */
const crypto = require('node:crypto');
const { canonical } = require('./formulaCatalog');
const AppError = require('../../../utils/AppError');
const { filterHashInvalid } = require('./sourceRefs.errors');

const HASH_RE = /^[0-9a-f]{64}$/;

function normalizeFilter(filter) {
  const f = filter || {};
  const out = { companyId: f.companyId };
  if (f.period) out.period = { from: f.period.from ?? null, to: f.period.to ?? null };
  if (Array.isArray(f.status) && f.status.length) out.status = [...f.status].map(String).sort();
  if (Array.isArray(f.nature) && f.nature.length) out.nature = [...f.nature].map(String).sort();
  if (f.equals && Object.keys(f.equals).length) out.equals = { ...f.equals };
  return out;
}

const hashFilter = (table, filter) => crypto.createHash('sha256').update(canonical({ table, filter: normalizeFilter(filter) })).digest('hex');

function serverKey() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw AppError.internal('Chave de assinatura do detalhe indisponível.', 'ANALYTICS_SIGNING_KEY_UNAVAILABLE');
  return crypto.createHmac('sha256', secret).update('analytics.source_refs.filter').digest();
}

const mac = (key, companyId, hash) => crypto.createHmac('sha256', key).update(`${companyId}|${hash}`, 'utf8').digest('hex');

async function signFilterHash(companyId, hash) {
  return mac(serverKey(), companyId, hash);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Confere { filter, filterHash, filterSignature } de um detalhe pedido. Qualquer diferença: 400 ANALYTICS_FILTER_HASH_INVALID. */
async function verifyFilter(companyId, table, { filter, filterHash, filterSignature }) {
  if (!filter || filter.companyId !== companyId || !HASH_RE.test(String(filterHash)) || !HASH_RE.test(String(filterSignature))) throw filterHashInvalid();
  if (hashFilter(table, filter) !== filterHash) throw filterHashInvalid();
  if (!safeEqual(await signFilterHash(companyId, filterHash), filterSignature)) throw filterHashInvalid();
  return normalizeFilter(filter);
}

module.exports = { normalizeFilter, hashFilter, signFilterHash, verifyFilter };
