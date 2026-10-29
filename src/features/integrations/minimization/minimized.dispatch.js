'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { PORTS } = require('../providers/ports');
const { createDispatch } = require('../dispatch/dispatch.create');
const { minimizePayload } = require('./minimize');
const { mapperMissing } = require('./minimization.errors');

/**
 * createMinimizedDispatch — a ÚNICA porta de envio a fornecedor com dado de domínio (M9-D219). Recebe o objeto de domínio
 * (campos simples, nunca a entidade nem o DTO da API), aplica o outputMapper da operação do port da conexão e grava o envio
 * (D205) com o payload JÁ minimizado: o `payload_snapshot` e o hash são do minimizado, e `purpose` e `fields_dropped` ficam
 * gravados. Violação de classificação num campo obrigatório: 422 INTEGRATION_PAYLOAD_CLASSIFICATION_VIOLATION e nada é gravado.
 * `d`: connectionId, operation, idempotencyKey, domainObject, consentedFields, criticalityOp, outboxEventId, aggregateType, aggregateId.
 */
async function createMinimizedDispatch(ctx, d, transaction) {
  if (!ctx || !ctx.companyId || !ctx.groupId) throw AppError.badRequest('Envio exige a empresa e o grupo.', 'VALIDATION_ERROR');
  const connection = await IntegrationConnection.findOne({ where: { id: d.connectionId, companyId: ctx.companyId }, attributes: ['id', 'providerCode'], transaction });
  if (!connection) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { attributes: ['code', 'domain'], transaction });
  const Port = provider && PORTS[provider.domain];
  const mapper = Port && Port.operations[d.operation] && Port.operations[d.operation].outputMapper;
  if (!mapper) throw mapperMissing(provider ? provider.domain : 'desconhecido', String(d.operation));

  const result = await minimizePayload({ domain: provider.domain, operation: d.operation, mapper }, d.domainObject, ctx, transaction, { consentedFields: d.consentedFields });
  const created = await createDispatch(ctx, {
    connectionId: connection.id, operation: d.operation, idempotencyKey: d.idempotencyKey, snapshot: result.payload, criticalityOp: d.criticalityOp,
    outboxEventId: d.outboxEventId, aggregateType: d.aggregateType, aggregateId: d.aggregateId, purpose: result.purpose, fieldsDropped: result.fieldsDropped.length,
  }, transaction);
  return { ...created, minimization: { purpose: result.purpose, fieldsKept: result.fieldsKept, fieldsDropped: result.fieldsDropped } };
}

module.exports = { createMinimizedDispatch };
