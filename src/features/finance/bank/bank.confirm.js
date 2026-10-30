'use strict';

const { resolveDispatchByEvent } = require('../../integrations/dispatch/reconcile');
const { readBankParams } = require('./bank.params');
const { toCents } = require('./bank.money');
const { dispatchOf } = require('./bank.dispatch');
const { recordAmountMismatch, approvedCents } = require('./bank.mismatch');

/**
 * Confere o valor do status final contra o aprovado (centavos). Devolve { ok:true } ou { ok:false, informedCents }. Sem valor informado vale o parâmetro
 * integration.bank.confirm_without_amount (padrão: confirma, como o código já fazia).
 */
async function checkAmount(intent, informed, transaction) {
  if (informed === undefined || informed === null || informed === '') {
    const { confirmWithoutAmount } = await readBankParams({ groupId: intent.groupId, companyId: intent.companyId }, transaction);
    return confirmWithoutAmount ? { ok: true } : { ok: false, informedCents: null };
  }
  const centavos = toCents(informed);
  return centavos !== null && centavos === approvedCents(intent) ? { ok: true } : { ok: false, informedCents: centavos };
}

/** Status final externo aplicado ao envio da intenção (CONFIRMED ou FAILED) pelo mesmo caminho do webhook e da reconciliação; o primeiro a confirmar vence. */
async function applyStatusToDispatch(intent, rawStatus, source, transaction) {
  const ctx = { groupId: intent.groupId, companyId: intent.companyId, userId: null };
  const dispatch = await dispatchOf(ctx, intent.id, transaction);
  if (!dispatch) return null;
  const sourceOk = source === 'STATUS_QUERY' ? 'STATUS_QUERY' : 'WEBHOOK_SIGNED';
  const r = await resolveDispatchByEvent(ctx, {
    providerCode: dispatch.providerCode, idempotencyKey: dispatch.idempotencyKey, externalResourceId: dispatch.externalResourceId || undefined, status: String(rawStatus).toUpperCase(), source: sourceOk,
  }, {}, transaction);
  return { dispatch, result: r };
}

/** Divergência de valor: grava o erro CRITICAL e devolve true (o chamador não confirma nada). */
async function rejectByAmount(intent, check, origin, transaction) {
  const ctx = { groupId: intent.groupId, companyId: intent.companyId, userId: null };
  const dispatch = await dispatchOf(ctx, intent.id, transaction);
  await recordAmountMismatch(intent, dispatch, { source: origin === 'STATUS_QUERY' ? 'SYNC' : 'WEBHOOK', informedCents: check.informedCents, origin }, transaction);
  return true;
}

module.exports = { checkAmount, applyStatusToDispatch, rejectByAmount };
