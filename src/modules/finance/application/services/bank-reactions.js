'use strict';

const { PaymentIntent } = require('../../../../models');
const { registerDomainReaction } = require('../../../../features/integrations/domain');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { PAYMENT_AGGREGATE } = require('../../infrastructure/bank/hub/bank.constants');

/** Evento de uma ordem de pagamento (aggregate PaymentIntent e operação submitPayment), ou null. */
const paymentEvent = (event) => {
  const p = event.payloadJson || {};
  return p.dispatchId && p.operation === 'submitPayment' && p.aggregate && p.aggregate.type === PAYMENT_AGGREGATE && p.aggregate.id ? p : null;
};

const lockIntent = (ctx, id, transaction) => PaymentIntent.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/**
 * `integration.dispatch.failed` da ordem (M9-D237 + M9-D220 3.1 item 2). O dinheiro só muda de estado com certeza:
 *  - o banco RECUSOU a ordem (classe VALIDATION: dado inválido, ou status final de recusa informado pelo banco) e a intenção está SUBMITTING sem id do banco: a intenção vai a FAILED,
 *    com o motivo em português; o lançamento segue pendente e uma nova intenção pode ser criada;
 *  - qualquer outra falha (credencial, tentativas esgotadas) NÃO decide a intenção: ela segue SUBMITTING, em envio incerto, até a reconciliação consultar o banco (a ausência de
 *    resposta nunca presume que o pagamento não saiu, B1 da revisão de 18/10/2026).
 * Pagamento liquidado ou dado como falho por outro caminho não muda. A liquidação (EXECUTED) continua só no caminho que confere o valor em centavos (`confirmBankPayment`): o evento
 * de confirmação não traz o valor, e uma liquidação por ele pularia a conferência do valor (DI-D237-10).
 */
async function onFailed(ctx, event, transaction) {
  const p = paymentEvent(event);
  if (!p) return null;
  const intent = await lockIntent(ctx, p.aggregate.id, transaction);
  if (!intent) return null;
  const classe = (event.payloadJson || {}).errorClass || 'ERROR';
  const antes = { status: intent.status, externalStatus: intent.externalStatus };
  if (classe === 'VALIDATION' && intent.status === 'SUBMITTING' && !intent.externalSubmissionId) {
    await intent.update({
      status: 'FAILED', failedAt: new Date(), uncertainSince: null, externalStatus: 'REJECTED',
      failureReason: 'O banco recusou a ordem de pagamento: confira os dados do favorecido e do valor e crie uma nova intenção de pagamento.',
    }, { transaction });
    return { entity: { type: PAYMENT_AGGREGATE, id: intent.id }, before: antes, after: { status: 'FAILED' }, reason: `Ordem ${p.dispatchId} recusada pelo banco (${classe}): a intenção vai a FAILED.` };
  }
  return { entity: { type: PAYMENT_AGGREGATE, id: intent.id }, before: antes, after: antes, reason: `Ordem ${p.dispatchId} falhou (${classe}) sem recusa do banco: a intenção foi mantida como está até a reconciliação.` };
}

/**
 * `integration.dispatch.needs_manual_review`: a ordem ficou sem resposta conclusiva do banco depois de todas as consultas de reconciliação. A intenção NÃO muda (o pagamento pode ter
 * saído): abre-se o caso de anomalia HIGH para uma pessoa conferir no extrato ou no painel do banco antes de qualquer nova ordem.
 */
async function onManualReview(ctx, event, transaction) {
  const p = paymentEvent(event);
  if (!p) return null;
  const intent = await lockIntent(ctx, p.aggregate.id, transaction);
  if (!intent || !['SUBMITTING', 'SUBMITTED'].includes(intent.status)) return null;
  const caso = await createAnomalyCase({
    groupId: intent.groupId, companyId: intent.companyId, caseType: 'BANK_PAYMENT_UNRESOLVED', riskLevel: 'HIGH', relatedEntityType: PAYMENT_AGGREGATE, relatedEntityId: intent.id,
    reason: `Não foi possível descobrir se o banco executou a ordem ${p.dispatchId} depois de várias consultas: confira no extrato ou no painel do banco antes de criar outra ordem.`,
  }, null, transaction);
  return { entity: { type: PAYMENT_AGGREGATE, id: intent.id }, before: { status: intent.status }, after: { status: intent.status, anomalyCaseId: caso.id }, reason: `Ordem ${p.dispatchId} sem resposta conclusiva: revisão humana aberta.` };
}

let installed = false;
function installBankReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'finance.bank.dispatch_failed', handler: onFailed });
  registerDomainReaction({ eventType: 'integration.dispatch.needs_manual_review', consumer: 'finance.bank.dispatch_needs_review', handler: onManualReview });
}

module.exports = { installBankReactions, onFailed, onManualReview };
