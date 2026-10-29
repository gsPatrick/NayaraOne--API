'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const logger = require('../../../../utils/logger');
const { retryError } = require('./retry.service');
const { testConnection } = require('./testConnection.service');
const { rotateSecret } = require('./rotate.service');

/** O chamador com as permissões da sessão (o retry e a reativação conferem a delas). */
const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });

/** POST /admin/integrations/errors/:id/retry -> 202. Recusa que gravou algo antes (reconciliação) responde depois do commit; o ciclo do fluxo roda depois do commit. */
const retry = catchAsync(async (req, res) => {
  const feito = await req.withTenantTransaction((t) => retryError(req.params.id, req.body, ctxDe(req), t));
  if (feito.conflict) throw feito.conflict;
  if (feito.afterCommit) {
    try { await feito.afterCommit(); } catch (err) { logger.warn({ err: err.message }, 'Retry humano: o pós-processamento do ciclo falhou; o erro segue em RETRYING até a próxima conferência.'); }
  }
  return success(res, { data: feito.body, statusCode: 202 });
});

/** POST /admin/integrations/:provider/test-connection -> 200 (falha do teste é ok:false, nunca 500). */
const test = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => testConnection(req.params.provider, req.body, ctxDe(req), t));
  return success(res, { data });
});

/** POST /admin/integrations/:provider/rotate-secret -> 200 com versões e fim da graça. */
const rotate = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => rotateSecret(req.params.provider, req.body, ctxDe(req), t));
  return success(res, { data });
});

module.exports = { retry, test, rotate };
