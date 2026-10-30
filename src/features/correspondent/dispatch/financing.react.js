'use strict';

const { FinancingCase, ProviderSubmission, IntegrationDispatch } = require('../../../models');
const { registerDomainReaction, compensateDispatch } = require('../../integrations/domain');
const { publishIntegrationCorrespondentFailed } = require('../correspondentEvents.service');

const AGGREGATE = 'ProviderSubmission';
const ENCERRADAS = ['FAILED', 'CANCELED'];
const MOTIVO_RECUSA = 'O provider recusou os dados do caso: corrija o apontado e envie de novo.';

/** Evento do envio do caso (submitCase de uma submissão): devolve o payload ou null. Só ids e códigos, nunca o conteúdo enviado. */
function submitEvent(event) {
  const p = event.payloadJson || {};
  return p.dispatchId && p.operation === 'submitCase' && p.aggregate && p.aggregate.type === AGGREGATE && p.aggregate.id ? p : null;
}

const lockSubmission = (ctx, id, transaction) => ProviderSubmission.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
const lockCase = (ctx, id, transaction) => FinancingCase.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/**
 * `integration.dispatch.confirmed` do envio do caso (M9-D240 + M9-D220 3.1 itens 2 e 5): o provider confirmou um caso que o Correspondente já deu por encerrado (submissão FAILED ou
 * CANCELED), ou seja, o caso existe no provider sem existir aqui. Caso que o próprio provider cancelou (submissão aceita) não passa por aqui. A COMPENSAÇÃO é um NOVO envio `cancelCase` (compensateDispatch, chave derivada do envio original);
 * o envio do caso e a submissão não são alterados. Caso em andamento (submissão aceita) não muda por aqui: o status do caso é aplicado pelo webhook assinado e pela consulta.
 */
async function onSubmitConfirmed(ctx, event, transaction) {
  const p = submitEvent(event);
  if (!p) return null;
  const submission = await lockSubmission(ctx, p.aggregate.id, transaction);
  if (!submission) return null;
  if (!ENCERRADAS.includes(submission.status)) return null;
  // Caso cancelado de propósito com cancelamento já pedido ao provider: não se pede outro.
  const pedidos = await IntegrationDispatch.count({ where: { companyId: ctx.companyId, aggregateType: AGGREGATE, aggregateId: submission.id, operation: 'cancelCase', status: ['PENDING', 'RETRY_WAIT', 'SENDING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'] }, transaction });
  if (pedidos > 0) return null;
  let r;
  try {
    r = await compensateDispatch(ctx, p.dispatchId, { transaction });
  } catch (err) {
    // Sem integração ativa (pausada, desativada) ou envio sem identificador: o cancelamento não pode ser pedido agora. O evento não pode travar a fila: fica a auditoria para uma pessoa decidir.
    if (!['INTEGRATION_CONNECTION_NOT_FOUND', 'INTEGRATION_COMPENSATION_NOT_APPLICABLE', 'INTEGRATION_COMPENSATION_UNSUPPORTED'].includes(err.code)) throw err;
    return { entity: { type: AGGREGATE, id: submission.id }, before: { status: submission.status }, after: { status: submission.status }, reason: `Envio ${p.dispatchId} confirmado com a submissão já ${submission.status}, mas o cancelamento não pôde ser pedido (${err.code}): confira o caso com o provider.` };
  }
  return {
    entity: { type: AGGREGATE, id: submission.id }, before: { status: submission.status }, after: { status: submission.status, compensationDispatchId: r.dispatch.id },
    reason: `Envio ${p.dispatchId} confirmado pelo provider com a submissão já ${submission.status}: cancelamento do caso pedido ao provider (envio ${r.dispatch.id}).`,
  };
}

/**
 * `integration.dispatch.failed` do envio do caso:
 *  - recusa definitiva (classe VALIDATION: o provider não aceitou os dados) de submissão ainda PENDING ou UNKNOWN, sem identificador no provider: a submissão vai a FAILED com o motivo em
 *    português (a correção é um novo envio);
 *  - qualquer outra falha (credencial, tentativas esgotadas, provider fora) NÃO muda a submissão: ela segue como está até a consulta pela chave ou uma pessoa decidirem (a ausência de
 *    resposta do provider nunca presume que o caso não existe).
 */
async function onSubmitFailed(ctx, event, transaction) {
  const p = submitEvent(event);
  if (!p) return null;
  const submission = await lockSubmission(ctx, p.aggregate.id, transaction);
  if (!submission) return null;
  const classe = (event.payloadJson || {}).errorClass || 'ERROR';
  const antes = { status: submission.status };
  if (classe === 'VALIDATION' && ['PENDING', 'UNKNOWN'].includes(submission.status) && !submission.externalCaseId) {
    await submission.update({ status: 'FAILED', failureReason: MOTIVO_RECUSA }, { transaction });
    const financingCase = await lockCase(ctx, submission.financingCaseId, transaction);
    if (financingCase) await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: MOTIVO_RECUSA, submissionId: submission.id }, transaction);
    return { entity: { type: AGGREGATE, id: submission.id }, before: antes, after: { status: 'FAILED' }, reason: `Envio ${p.dispatchId} recusado pelo provider (${classe}): a submissão vai a FAILED.` };
  }
  return { entity: { type: AGGREGATE, id: submission.id }, before: antes, after: antes, reason: `Envio ${p.dispatchId} falhou (${classe}): a submissão foi mantida como está até a consulta pela chave ou uma pessoa decidir.` };
}

let installed = false;
function installFinancingReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'correspondent.financing.dispatch_confirmed', handler: onSubmitConfirmed });
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'correspondent.financing.dispatch_failed', handler: onSubmitFailed });
}

module.exports = { installFinancingReactions, onSubmitConfirmed, onSubmitFailed };
