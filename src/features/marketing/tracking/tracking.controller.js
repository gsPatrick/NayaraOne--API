'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./tracking.service');

// GET /marketing/attribution?campaignId=&from=&to=&model=first|last: relatório agregado por campanha e canal (M9-D431).
async function attribution(req, res) {
  const data = await req.withTenantTransaction((t) => service.attributionReport(tenantFromAuth(req), req.query, t));
  return success(res, { data });
}

// POST /marketing/tracking-links (I5): gera o link de rastreio assinado.
async function createLink(req, res) {
  const data = await req.withTenantTransaction((t) => service.createTrackingLink({ tenant: tenantFromAuth(req), actor: req.auth.userId, input: req.body }, t));
  return success(res, { statusCode: 201, data });
}

// GET /t/:shortCode (I6, pública): 302 para o destino com as UTMs; link inválido ou adulterado devolve 404 sem registrar nada.
async function redirect(req, res) {
  const out = await service.resolveClick({
    shortCode: req.params.shortCode, token: typeof req.query.r === 'string' ? req.query.r : null,
    session: { ip: req.ip, userAgent: req.get('user-agent') || '' },
  });
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(302, out.location);
}

module.exports = { attribution, createLink, redirect };
