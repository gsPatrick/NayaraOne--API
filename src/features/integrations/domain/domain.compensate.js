'use strict';

const { IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dispatchService = require('../dispatch/enqueue/dispatch.service');

/** A operação que desfaz cada operação que cria efeito externo (M9-D220 3.1 item 5). Operação fora da tabela não tem compensação automática. */
const COMPENSATIONS = Object.freeze({
  createEnvelope: 'cancelEnvelope', publishListing: 'unpublishListing', publishPost: 'deletePost', publishPage: 'unpublishPage', issueNfse: 'cancelNfse', submitCase: 'cancelCase',
});

/**
 * compensateDispatch — desfaz por regra de negócio uma operação que o fornecedor JÁ aceitou (ex.: despublicar o anúncio depois da venda): cria um NOVO envio com a operação
 * compensatória sobre o mesmo recurso externo e a mesma connection, na transação do domínio. O envio original nunca é alterado nem apagado (é a prova do que aconteceu). A chave de
 * idempotência é derivada do original: pedir duas vezes devolve o mesmo envio de compensação. Devolve { dispatch, created }.
 */
async function compensateDispatch(ctx, dispatchId, { userId = null, transaction }) {
  const original = await IntegrationDispatch.findOne({ where: { id: dispatchId, companyId: ctx.companyId }, transaction });
  if (!original) throw AppError.notFound('Envio não encontrado.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  const operation = COMPENSATIONS[original.operation];
  if (!operation) throw AppError.unprocessable('Esta operação não tem compensação automática.', 'INTEGRATION_COMPENSATION_UNSUPPORTED');
  if (!['SUBMITTED', 'CONFIRMED'].includes(original.status) || !original.externalResourceId) {
    throw AppError.conflict('Só se compensa o que o fornecedor já aceitou e devolveu o identificador.', 'INTEGRATION_COMPENSATION_NOT_APPLICABLE');
  }
  const r = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: original.connectionId, operation, aggregateType: original.aggregateType, aggregateId: original.aggregateId,
    payload: { externalResourceId: original.externalResourceId }, idempotencyKey: `compensate:${original.id}`, userId, transaction,
  });
  if (r.created) {
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: userId, action: 'integration.dispatch.compensation_requested', entityType: 'IntegrationDispatch', entityId: r.dispatchId,
      beforeJson: { originalDispatchId: original.id, operation: original.operation, status: original.status }, afterJson: { compensationDispatchId: r.dispatchId, operation },
      reason: `Compensação ${operation} do envio ${original.id} (${original.operation}); o envio original foi preservado.`,
    }, transaction);
  }
  return { dispatch: r.dispatch, created: r.created };
}

module.exports = { compensateDispatch, COMPENSATIONS };
