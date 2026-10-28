'use strict';

const { IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { refusalReason } = require('./dispatchStateMachine');
const { invalidTransition, translateDispatchDbError } = require('./dispatch.errors');
const { auditarMudanca, visao } = require('./dispatch.audit');
const { ERROR_CLASSES, HUMAN_RETRY_EXTRA_ATTEMPTS } = require('./dispatch.constants');

/** Campos que quem transiciona pode informar (o conteúdo aprovado nunca está aqui). */
const PATCH_FIELDS = ['externalRequestId', 'externalResourceId', 'nextAttemptAt', 'lastErrorClass', 'lastErrorCode', 'lastHttpStatus', 'reconcileAttempts'];

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
  if (to === 'CONFIRMED') efeitos.confirmedAt = agora;
  if (to === 'UNKNOWN') efeitos.unknownSince = agora;
  if (row.status === 'UNKNOWN' && to !== 'UNKNOWN') efeitos.unknownSince = null;
  if (row.status === 'DEAD_LETTER' && to === 'RETRY_WAIT' && opts.humanRetry) efeitos.maxAttempts = row.maxAttempts + HUMAN_RETRY_EXTRA_ATTEMPTS;
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
  if (refusalReason(row.status, to, { criticalityOp: row.criticalityOp, humanRetry: opts.humanRetry, reconciled: opts.reconciled })) throw invalidTransition(row.status, to);
  const antes = visao(row);
  try {
    await row.update({ ...pickPatch(patch), ...sideEffects(row, to, opts), status: to }, { transaction });
  } catch (err) {
    throw translateDispatchDbError(err);
  }
  await auditarMudanca(ctx, antes, row, opts.motivo || `Envio: ${antes.status} -> ${to}.`, transaction);
  return row;
}

module.exports = { transitionDispatch, applyTransition };
