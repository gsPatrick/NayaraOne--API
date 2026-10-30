'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../marketing.module');
const media = require('./media.service');
const { videoInvalid } = require('./video.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /marketing/media/:id/authorize (rota I9 da M9-D435): autoriza o arquivo para uso em marketing, com a origem.
async function authorize(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw videoInvalid('Corpo da requisição inválido.');
  const unknown = Object.keys(body).filter((k) => k !== 'origin');
  if (unknown.length) throw videoInvalid(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
  if (typeof body.origin !== 'string' || !body.origin.trim()) throw videoInvalid('Dados inválidos: origin.', { field: 'origin' });
  if (!UUID_RE.test(String(req.params.id))) throw videoInvalid('Dados inválidos: id do arquivo.', { field: 'id' });
  const data = await req.withTenantTransaction((t) => media.authorizeMedia({ tenant: tenantFromAuth(req), auth: req.auth, fileId: req.params.id, origin: body.origin }, t));
  return success(res, { data });
}

module.exports = { authorize };
