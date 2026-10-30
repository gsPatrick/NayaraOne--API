'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { publishToPortals, listPortalListings } = require('./portal.publish');
const { unpublishFromPortals } = require('./portal.unpublish');

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

/** Publica (ou atualiza) o imóvel em cada portal contratado: 202 com a lista por portal; um portal com problema nunca devolve erro geral. */
const publish = catchAsync(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.connectionIds) ? req.body.connectionIds : undefined;
  const data = await req.withTenantTransaction((t) => publishToPortals(ctxOf(req), { propertyId: req.params.id, connectionIds: ids }, t));
  return success(res, { statusCode: 202, data: { ...data, message: `Publicação iniciada: ${data.total} portal(is); acompanhe o status de cada um.` } });
});

/** Despublica o imóvel em cada portal: 202 com a lista por portal (UNPUBLISHING até o portal confirmar). Um portal fora do ar nunca vira erro geral. */
const unpublish = catchAsync(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.connectionIds) ? req.body.connectionIds : undefined;
  const data = await req.withTenantTransaction((t) => unpublishFromPortals(ctxOf(req), { propertyId: req.params.id, connectionIds: ids }, t));
  return success(res, { statusCode: 202, data: { ...data, summary: `${data.published} de ${data.total} portais publicados` } });
});

const list = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listPortalListings(ctxOf(req), req.params.id, t));
  return success(res, { data: { ...data, summary: `${data.published} de ${data.total} portais publicados` } });
});

module.exports = { publish, unpublish, list };
