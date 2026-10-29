'use strict';

const { IntegrationError } = require('../../../../models');
const { readActionParams } = require('./actions.params');
const { parseRetryBody } = require('./actions.body');
const { notAllowed, errorNotFound } = require('./retry.errors');
const { auditRetryRequested } = require('./retry.audit');
const { retryDispatchError } = require('./retry.dispatch');
const { retryWebhookError } = require('./retry.webhook');
const { retrySyncError } = require('./retry.sync');

const RETRYABLE_SOURCES = Object.freeze(['DISPATCH', 'WEBHOOK', 'SYNC']);
const BRANCHES = Object.freeze({ DISPATCH: retryDispatchError, WEBHOOK: retryWebhookError, SYNC: retrySyncError });

const resposta = (error, dispatchId) => ({ errorId: error.id, status: 'RETRYING', dispatchId: dispatchId || null });

/**
 * POST /admin/integrations/errors/:id/retry (M9-D250 3.1). Trava o erro (FOR UPDATE) e relê: de dois retries simultâneos um vence e o outro encontra RETRYING e recebe o mesmo 202.
 * Só erro OPEN de origem DISPATCH, WEBHOOK ou SYNC; SECURITY e VALIDATION são permanentes (409). O erro vai a RETRYING e a auditoria guarda motivo e aprovador.
 * Devolve { body, conflict?, afterCommit? }: `conflict` é o 409 que o controlador responde DEPOIS do commit (a reconciliação gravou o que descobriu);
 * `afterCommit` roda o ciclo de um fluxo de sincronização depois que a transação fechou.
 */
async function retryError(errorId, rawBody, ctx, transaction) {
  const body = parseRetryBody(rawBody);
  const error = await IntegrationError.findOne({ where: { id: errorId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!error) throw errorNotFound();
  if (error.status === 'RETRYING') return { body: resposta(error, error.source === 'DISPATCH' ? error.financingCaseId : null) };
  if (error.status !== 'OPEN') throw notAllowed({ errorStatus: error.status });
  if (!RETRYABLE_SOURCES.includes(error.source)) throw notAllowed({ source: error.source });
  // SECURITY nunca; VALIDATION é dado errado (repetir dá o mesmo erro), salvo o evento de webhook, cuja regra própria responde 410 pelo conteúdo que não existe.
  if (error.errorClass === 'SECURITY' || (error.errorClass === 'VALIDATION' && error.source !== 'WEBHOOK')) throw notAllowed({ errorClass: error.errorClass });

  const params = await readActionParams(ctx, transaction);
  const feito = await BRANCHES[error.source](ctx, error, body, params, transaction);
  if (feito.conflict) return { conflict: feito.conflict };

  const alvo = feito.dispatchId ? { dispatchId: feito.dispatchId } : (feito.inboxId ? { inboxId: feito.inboxId } : { cursorId: feito.cursorId });
  await error.update({ status: 'RETRYING' }, { transaction });
  await auditRetryRequested(ctx, error, alvo, { reason: body.reason, dangerous: feito.dangerous === true, confirmDangerous: body.confirmDangerous }, transaction);
  return { body: resposta(error, feito.dispatchId), afterCommit: feito.afterCommit };
}

module.exports = { retryError };
