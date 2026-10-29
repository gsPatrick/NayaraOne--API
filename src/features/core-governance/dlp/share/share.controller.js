'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const settings = require('./share.settings');
const { getSetting } = require('../../../settings/settings.service');
const service = require('./share.service');
const { accessPublicShare } = require('./share.public');

const actor = (req) => ({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, permissions: req.auth.permissions });

/** Endereço completo do link: o parâmetro `url_base` (ex.: o site público) ou, em AUTO, o endereço da própria requisição. */
async function linkUrl(req, token, transaction) {
  const base = settings.urlBase(await getSetting(settings.URL_BASE_KEY, tenantFromAuth(req), transaction, settings.SHARE_SETTING_DEFAULTS[settings.URL_BASE_KEY]));
  return `${base || `${req.protocol}://${req.get('host')}`}/api/v1/public/share/${token}`;
}

async function create(req, res) {
  const out = await req.withTenantTransaction(async (transaction) => {
    const data = await service.createShareLink({ ...actor(req), body: req.body, idempotencyKey: req.get('Idempotency-Key'), transaction });
    return { ...data, url: data.token ? await linkUrl(req, data.token, transaction) : null };
  });
  if (out.replayed) res.set('Idempotent-Replay', 'true');
  res.set('Cache-Control', 'no-store');
  return success(res, { statusCode: 201, data: { ...out.link, token: out.token, url: out.url, tokenShown: !out.replayed } });
}

async function revoke(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.revokeShareLink({ ...actor(req), id: req.params.id, transaction }));
  return success(res, { data });
}

async function list(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.listShareLinks({ ...actor(req), transaction }));
  return success(res, { data });
}

/** Rota pública: cabeçalhos de limite em toda resposta, Retry-After no 429, nada em cache e sem indexação; arquivo avulso sai como anexo. */
async function publicAccess(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  let out;
  try {
    out = await accessPublicShare({ token: req.params.token, ip: req.ip });
  } catch (error) {
    if (error.code === 'GOV_RATE_LIMITED' && error.details) res.set('Retry-After', String(error.details.retryAfter));
    throw error;
  }
  const { state, result } = out;
  res.set({ 'X-RateLimit-Limit': String(state.limit), 'X-RateLimit-Remaining': String(Math.max(0, state.limit - state.hits)) });
  if (result.file) {
    res.set('Content-Type', result.file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${result.file.fileName}"`);
    return res.status(200).send(result.file.buffer);
  }
  return success(res, { data: { resourceType: result.link.resourceType, expiresAt: result.link.expiresAt, resource: result.data, watermark: result.mark } });
}

module.exports = { create, revoke, list, publicAccess };
