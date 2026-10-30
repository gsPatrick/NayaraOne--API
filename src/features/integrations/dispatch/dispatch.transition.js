'use strict';

const { IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { refusalReason } = require('./dispatchStateMachine');
const { invalidTransition, translateDispatchDbError } = require('./dispatch.errors');
const { auditarMudanca, visao } = require('./dispatch.audit');
const { ERROR_CLASSES, HUMAN_RETRY_EXTRA_ATTEMPTS } = require('./dispatch.constants');
const { settleRetryingErrors } = require('../errors/errors.settle');
const { onDispatchConfirmed } = require('../../core-governance/finops/finops.hooks');

/** Campos que quem transiciona pode informar (o conteúdo aprovado nunca está aqui). */
const PATCH_FIELDS = ['externalRequestId', 'externalResourceId', 'nextAttemptAt', 'lastErrorClass', 'lastErrorCode', 'lastHttpStatus', 'reconcileAttempts', 'externalStatus', 'authRenewals', 'deadLetterReason'];

function pickPatch(patch) {
  const out = {};
  PATCH_FIELDS.forEach((k) => { if (patch && patch[k] !== undefined) out[k] = patch[k]; });
  if (out.lastErrorClass && !ERROR_CLASSES.includes(out.lastErrorClass)) {
    throw AppError.unprocessable(`Classe de erro inválida. Use: ${ERROR_CLASSES.join(', ')}.`, 'INTEGRATION_DISPATCH_INVALID');
  }
  return out;
}

/** Efeitos colaterais de entrar em cada estado (datas e contadores). */
function sideEffects(row, to, opts) {
  const agora = new Date();
  const efeitos = {};
  if (to === 'SENDING') efeitos.attempts = row.attempts + 1;
  if (to === 'SUBMITTED') efeitos.submittedAt = agora;
  // Devolução sem tentativa gasta (circuito, cota, conexão parada, AUTH ou 429): o contador volta ao que era antes do SENDING.
  if (opts.refundAttempt && row.attempts > 0) efeitos.attempts = row.attempts - 1;
  if (to === 'CONFIRMED') efeitos.confirmedAt = agora;
  // Em UNKNOWN a data da próxima consulta nasce vazia (vale unknown_since + a 1ª espera, M9-D215): a do último envio não vale mais.
  if (to === 'UNKNOWN') { efeitos.unknownSince = agora; efeitos.nextAttemptAt = null; }
  if (row.status === 'UNKNOWN' && to !== 'UNKNOWN') efeitos.unknownSince = null;
  if (row.status === 'DEAD_LETTER' && to !== 'DEAD_LETTER') efeitos.deadLetterReason = null;
  if (row.status === 'DEAD_LETTER' && to === 'RETRY_WAIT' && opts.humanRetry) efeitos.maxAttempts = row.maxAttempts + (Number.isInteger(opts.extraAttempts) && opts.extraAttempts >= 0 ? opts.extraAttempts : HUMAN_RETRY_EXTRA_ATTEMPTS);
  return efeitos;
}

/**
 * transitionDispatch — trava a linha (FOR UPDATE), RELÊ o status, confere a tabela de transições e grava com auditoria
 * antes/depois. `opts`: humanRetry (só dispatch.retry.js passa, após checar a permissão), reconciled (D215), motivo.
 */
async function transitionDispatch(ctx, id, to, patch, opts, transaction) {
  const o = opts || {};
  const row = await IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw AppError.notFound('Envio não encontrado.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  return applyTransition(ctx, row, to, patch, o, transaction);
}

/** Mesma regra, para quem já tem a linha travada (claim, recuperador). */
async function applyTransition(ctx, row, to, patch, opts, transaction) {
  if (refusalReason(row.status, to, { criticalityOp: row.criticalityOp, humanRetry: opts.humanRetry, reconciled: opts.reconciled, authRecovery: opts.authRecovery })) throw invalidTransition(row.status, to);
  const antes = visao(row);
  try {
    await row.update({ ...pickPatch(patch), ...sideEffects(row, to, opts), status: to }, { transaction });
  } catch (err) {
    throw translateDispatchDbError(err);
  }
  await auditarMudanca(ctx, antes, row, opts.motivo || `Envio: ${antes.status} -> ${to}.`, transaction);
  // M9-D250: o erro que foi a RETRYING no retry humano fecha com o desfecho do envio (confirmou: resolve; voltou a falhar: reabre).
  if (to === 'CONFIRMED') await onDispatchConfirmed(ctx, row, transaction); // M9-D860: uma unidade de mensageria no ledger do FinOps
  if (to === 'CONFIRMED') await settleRetryingErrors(ctx, row.id, 'RESOLVED', transaction, 'O envio repetido foi confirmado pelo fornecedor.');
  else if (['FAILED', 'DEAD_LETTER', 'UNKNOWN'].includes(to)) await settleRetryingErrors(ctx, row.id, 'OPEN', transaction);
  return row;
}

module.exports = { transitionDispatch, applyTransition };
