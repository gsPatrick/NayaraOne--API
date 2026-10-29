'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const AppError = require('../../../utils/AppError');
const { listActiveContingencies } = require('./contingency.list');
const { switchToAlternate } = require('./contingency.switch');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

/** GET /admin/integrations/contingency: contingências ativas da empresa. */
const list = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listActiveContingencies(ctxDe(req), t));
  return success(res, { data });
});

/** POST /admin/integrations/contingency/dispatches/:id/switch { approve: true }: troca um envio da fila para o alternativo (MFA recente no roteador). */
const switchDispatch = catchAsync(async (req, res) => {
  if (req.body && req.body.approve !== undefined && typeof req.body.approve !== 'boolean') throw AppError.badRequest('O campo "approve" precisa ser verdadeiro ou falso.', 'VALIDATION_ERROR');
  const approved = Boolean(req.body && req.body.approve === true);
  const data = await req.withTenantTransaction((t) => switchToAlternate(ctxDe(req), req.params.id, { approved }, t));
  return success(res, { data });
});

module.exports = { list, switchDispatch };
