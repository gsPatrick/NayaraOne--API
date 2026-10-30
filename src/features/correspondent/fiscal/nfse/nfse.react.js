'use strict';

const { InvoiceRequest, InvoiceEvent, IntegrationDispatch } = require('../../../../models');
const { registerDomainReaction, compensateDispatch } = require('../../../integrations/domain');

const AGGREGATE = 'InvoiceRequest';
/** Onde o evento do envio é de uma nota: aggregate InvoiceRequest e operação do port FiscalAdapter que a reação conhece. */
const noteEvent = (event, operations) => {
  const p = event.payloadJson || {};
  return p.dispatchId && p.aggregate && p.aggregate.type === AGGREGATE && p.aggregate.id && operations.includes(p.operation) ? p : null;
};

const lockNote = (ctx, id, transaction) => InvoiceRequest.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
const addEvent = (note, rawStatus, normalizedStatus, text, transaction) => InvoiceEvent.create({
  groupId: note.groupId, companyId: note.companyId, invoiceRequestId: note.id, rawStatus, normalizedStatus, note: text.slice(0, 1000), occurredAt: new Date(),
}, { transaction });

/**
 * `integration.dispatch.confirmed` da emissão (M9-D241 + M9-D220 3.1 itens 2 e 5): quando o emissor confirma uma nota que o Fiscal já deu por encerrada (pedido CANCELED ou REJECTED:
 * por exemplo, o pedido foi encerrado como "o emissor não recebeu" e a reconciliação depois achou a nota), a nota existe no emissor sem existir aqui. A COMPENSAÇÃO é um NOVO envio
 * `cancelNfse` (compensateDispatch), com a chave derivada do envio original; o envio da emissão e o pedido não são alterados (nota que o próprio Fiscal já mandou cancelar não pede outro). Nota em andamento ou autorizada não muda por aqui:
 * a autorização (número oficial, XML) é aplicada pela consulta de status, com a validação do que o emissor devolve.
 */
async function onIssueConfirmed(ctx, event, transaction) {
  const p = noteEvent(event, ['issueNfse']);
  if (!p) return null;
  const note = await lockNote(ctx, p.aggregate.id, transaction);
  if (!note || !['CANCELED', 'REJECTED'].includes(note.status)) return null;
  // Nota cancelada de propósito (cancelamento pedido ao emissor pelo Fiscal): o cancelamento já existe, não se pede outro.
  const pedidos = await IntegrationDispatch.count({ where: { companyId: ctx.companyId, aggregateType: AGGREGATE, aggregateId: note.id, operation: 'cancelNfse', status: ['PENDING', 'RETRY_WAIT', 'SENDING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'] }, transaction });
  if (pedidos > 0) return null;
  const original = await IntegrationDispatch.findOne({ where: { id: p.dispatchId, companyId: ctx.companyId }, transaction });
  const rps = original && original.payloadSnapshot ? original.payloadSnapshot.rps : undefined;
  const r = await compensateDispatch(ctx, p.dispatchId, { transaction, payload: { reason: 'Nota emitida no emissor depois de o pedido ser encerrado no sistema: cancelamento compensatório.', ...(rps ? { rps } : {}) } });
  await addEvent(note, 'COMPENSATION_REQUESTED', note.status, 'A nota foi emitida no emissor depois de o pedido ser encerrado aqui: o cancelamento foi pedido ao emissor.', transaction);
  return { entity: { type: AGGREGATE, id: note.id }, before: { status: note.status }, after: { status: note.status, compensationDispatchId: r.dispatch.id }, reason: `Emissão ${p.dispatchId} confirmada pelo emissor com o pedido já ${note.status}: cancelamento compensatório pedido (envio ${r.dispatch.id}).` };
}

/**
 * `integration.dispatch.failed`:
 *  - emissão recusada em definitivo (classe VALIDATION: a prefeitura não aceitou os dados) de nota ainda REQUESTED ou UNKNOWN, sem identificador no emissor: a nota vai a REJECTED com o
 *    motivo em português (a correção é outra nota, com outro RPS);
 *  - qualquer outra falha da emissão (credencial, tentativas esgotadas) NÃO muda a nota: ela segue como está, com o rastro no histórico, até a consulta por RPS ou uma pessoa decidirem
 *    (a ausência de resposta do emissor nunca presume que a nota não existe);
 *  - cancelamento recusado: a nota segue AUTORIZADA e o histórico registra o pedido recusado.
 * Só o envio corrente da nota conta.
 */
async function onFailed(ctx, event, transaction) {
  const p = noteEvent(event, ['issueNfse', 'cancelNfse']);
  if (!p) return null;
  const note = await lockNote(ctx, p.aggregate.id, transaction);
  if (!note) return null;
  const classe = (event.payloadJson || {}).errorClass || 'ERROR';
  const antes = { status: note.status };
  if (p.operation === 'cancelNfse') {
    await addEvent(note, 'CANCEL_FAILED', note.status, `O emissor não aceitou o pedido de cancelamento (${classe}): a nota segue ${note.status}.`, transaction);
    return { entity: { type: AGGREGATE, id: note.id }, before: antes, after: antes, reason: `Cancelamento ${p.dispatchId} falhou no emissor: a nota foi mantida.` };
  }
  if (note.dispatchId && note.dispatchId !== p.dispatchId) return null;
  if (classe === 'VALIDATION' && ['REQUESTED', 'UNKNOWN'].includes(note.status) && !note.externalId) {
    const motivo = 'O emissor recusou os dados do pedido: corrija o cadastro e emita de novo (a nova nota usa outro RPS).';
    await note.update({ status: 'REJECTED', rejectionReason: motivo, dispatchId: note.dispatchId || p.dispatchId }, { transaction });
    await addEvent(note, 'REJECTED', 'REJECTED', motivo, transaction);
    return { entity: { type: AGGREGATE, id: note.id }, before: antes, after: { status: 'REJECTED' }, reason: `Emissão ${p.dispatchId} recusada pelo emissor (${classe}): a nota vai a REJECTED.` };
  }
  await addEvent(note, 'ISSUE_FAILED', note.status, `A emissão falhou no emissor (${classe}): a nota foi mantida como está até a consulta por RPS ou uma pessoa decidir.`, transaction);
  return { entity: { type: AGGREGATE, id: note.id }, before: antes, after: antes, reason: `Emissão ${p.dispatchId} falhou (${classe}): a nota foi mantida.` };
}

let installed = false;
function installNfseReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'correspondent.nfse.dispatch_confirmed', handler: onIssueConfirmed });
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'correspondent.nfse.dispatch_failed', handler: onFailed });
}

module.exports = { installNfseReactions, onIssueConfirmed, onFailed };
