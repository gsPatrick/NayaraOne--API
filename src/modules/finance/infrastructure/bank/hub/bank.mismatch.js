'use strict';

const { IntegrationDispatch, PaymentIntent } = require('../../../../../models');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');
const { recordError } = require('../../../../../features/integrations/errors');
const { transitionDispatch } = require('../../../../../features/integrations/dispatch/dispatch.transition');
const { MISMATCH_CODE, MISMATCH_MESSAGE, DECISION_REJECT_PAYMENT } = require('./bank.constants');
const { toCents } = require('./bank.money');

/** Valor do pagamento aprovado e o valor informado pelo banco, em centavos (null quando algum dos dois não é um decimal limpo). */
const approvedCents = (intent) => toCents(intent.snapshotJson && intent.snapshotJson.amount);

/**
 * Valor confirmado diferente do aprovado (M9-D237 3.3 item 3): o envio NÃO vai a CONFIRMED, permanece onde estava (SUBMITTED ou UNKNOWN) e o erro CRITICAL
 * INTEGRATION_BANK_AMOUNT_MISMATCH fica OPEN para revisão humana (a resolução do erro, M9-D207, decide se o pagamento vale). Idempotente por envio: o mesmo
 * erro aberto agrupa as repetições. `info`: source (WEBHOOK ou SYNC), informedCents, origin (texto curto de onde veio).
 */
async function recordAmountMismatch(intent, dispatch, info, transaction) {
  const ctx = { groupId: intent.groupId, companyId: intent.companyId, userId: null };
  const erro = await recordError(ctx, {
    providerCode: dispatch ? dispatch.providerCode : 'bank', connectionId: dispatch ? dispatch.connectionId : null, source: info.source || 'WEBHOOK', sourceRefId: dispatch ? dispatch.id : null,
    operation: 'submitPayment', errorClass: 'VALIDATION', errorCode: MISMATCH_CODE, severity: 'CRITICAL', message: MISMATCH_MESSAGE, httpStatus: 409,
    payload: { paymentIntentId: intent.id, approvedCents: approvedCents(intent), informedCents: info.informedCents ?? null, origin: info.origin || null },
    allowlist: ['paymentIntentId', 'approvedCents', 'informedCents', 'origin'],
  }, transaction);
  await registrarAuditoria({
    groupId: intent.groupId, companyId: intent.companyId, actorUserId: null, action: 'finance.payment_intent.bank_amount_mismatch', entityType: 'PaymentIntent', entityId: intent.id,
    beforeJson: { status: intent.status }, afterJson: { status: intent.status, approvedCents: approvedCents(intent), informedCents: info.informedCents ?? null }, reason: 'O valor confirmado pelo banco difere do valor aprovado: pagamento não confirmado, revisão humana aberta.',
  }, transaction);
  return erro;
}

/**
 * Resolução humana do erro de valor divergente (registrada em errors.hooks): decisão REJECT_PAYMENT = o pagamento não vale. O envio (SUBMITTED ou UNKNOWN) vai a FAILED
 * e a intenção do Financeiro também (a confirmação tardia do banco abrirá o caso de anomalia). Outra decisão não mexe em nada.
 */
async function onMismatchResolved({ error, decision, ctx, transaction }) {
  if (decision !== DECISION_REJECT_PAYMENT || !error.financingCaseId) return;
  const dispatch = await IntegrationDispatch.findOne({ where: { id: error.financingCaseId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!dispatch) return;
  if (['SUBMITTED', 'UNKNOWN'].includes(dispatch.status)) {
    await transitionDispatch(ctx, dispatch.id, 'FAILED', { lastErrorClass: 'VALIDATION', lastErrorCode: MISMATCH_CODE }, { motivo: 'Revisão humana: o pagamento com valor divergente não vale.' }, transaction);
  }
  const intent = await PaymentIntent.findOne({ where: { id: dispatch.aggregateId }, transaction, lock: transaction.LOCK.UPDATE });
  if (intent && intent.status === 'EXECUTING') {
    const antes = { status: intent.status };
    await intent.update({ status: 'FAILED', failedAt: new Date(), uncertainSince: null, failureReason: 'Revisão humana: o valor confirmado pelo banco difere do aprovado e o pagamento foi rejeitado.' }, { transaction });
    await registrarAuditoria({
      groupId: intent.groupId, companyId: intent.companyId, actorUserId: ctx.userId || null, action: 'finance.payment_intent.bank_payment_failed', entityType: 'PaymentIntent', entityId: intent.id,
      beforeJson: antes, afterJson: { status: 'FAILED' }, reason: 'Pagamento rejeitado na revisão do valor divergente (INTEGRATION_BANK_AMOUNT_MISMATCH).',
    }, transaction);
  }
}

module.exports = { recordAmountMismatch, onMismatchResolved, approvedCents };
