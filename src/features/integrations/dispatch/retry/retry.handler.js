'use strict';

const { IntegrationConnection } = require('../../../../models');
const { classifyDispatchError } = require('./retry.classify');
const { resolveEffectivePolicy } = require('./retry.policy');
const { annotateAttempt } = require('./retry.report');
const { applyTransient, applyRateLimit, applyValidation, applyUnknown } = require('./retry.apply');
const { applyAuth } = require('./retry.auth');

/**
 * handleClassifiedFailure — o tratador de falha registrado no worker (M9-D216). Reclassifica pelo motor (opClass, idempotência e
 * código próprio do fornecedor), lê a política efetiva da connection (global < fornecedor < connection) e aplica a política da classe.
 * Roda na transação da tentativa, com o envio travado em SENDING.
 */
async function handleClassifiedFailure(args) {
  const { ctx, dispatch, adapter, error, classification, attemptId, httpStatus, now, transaction } = args;
  const connection = await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction });
  const policy = await resolveEffectivePolicy(ctx, connection, transaction);
  const idempotent = Boolean(adapter && adapter.supportsIdempotency && adapter.supportsIdempotency(dispatch.operation));
  const cls = classifyDispatchError(error, classification, { opClass: dispatch.criticalityOp, idempotent, now });
  if (cls.class !== classification.class || cls.code !== classification.code) await annotateAttempt(attemptId, { errorClass: cls.class, errorCode: cls.code }, transaction);
  const h = { ctx, dispatch, connection, adapter, policy, attemptId, httpStatus, now, transaction };
  switch (cls.class) {
    case 'TRANSIENT': return applyTransient(h, cls);
    case 'RATE_LIMIT': return applyRateLimit(h, cls);
    case 'AUTH': return applyAuth(h, cls);
    case 'VALIDATION': return applyValidation(h, cls);
    default: return applyUnknown(h, cls);
  }
}

module.exports = { handleClassifiedFailure };
