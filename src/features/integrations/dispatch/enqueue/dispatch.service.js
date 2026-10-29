'use strict';

const AppError = require('../../../../utils/AppError');
const { validar } = require('../../registry/jsonSchemaLite');
const { minimizePayload } = require('../../minimization/minimize');
const { createDispatch } = require('../dispatch.create');
const { hashPayload } = require('../canonicalJson');
const { normalizeSnapshot } = require('./normalizeSnapshot');
const { deriveIdempotencyKey } = require('./idempotencyKey');
const { resolveOpClass } = require('./dispatch.opClass');
const { resolveTarget } = require('./resolveTarget');
const { resolveEffectivePolicy } = require('../retry/retry.policy');

const conflict = () => AppError.conflict('Mesma chave de idempotência com conteúdo diferente.', 'INTEGRATION_IDEMPOTENCY_CONFLICT');
const payloadInvalid = (problemas) => AppError.unprocessable('Os dados não atendem ao formato exigido pelo fornecedor.', 'INTEGRATION_PAYLOAD_INVALID', { problemas });

/**
 * enqueue — a ÚNICA porta por onde um módulo de domínio pede algo a um fornecedor (M9-D214 3.1). Roda DENTRO da transação do domínio
 * (a linha nasce junto com o dado de negócio, INT-012) e devolve o recibo { dispatchId, status:'PENDING' }: nenhuma chamada externa
 * acontece aqui, quem chama é o worker. Passos: connection ACTIVE e operação nas capabilities; payload minimizado pelo mapper de
 * saída (M9-D219) e validado pelo schema do port; snapshot canônico e hash; chave de idempotência (a informada, senão a derivada
 * do conteúdo); repetir a mesma intenção devolve o mesmo envio; chave informada com conteúdo diferente é 409.
 * `args`: companyId, connectionId | domain, operation, aggregateType, aggregateId, payload, idempotencyKey?, opClass?, correlationId,
 * outboxEventId, userId, consentedFields, essential, transaction.
 */
async function enqueue(args) {
  const a = args || {};
  if (!a.transaction) throw AppError.internal('O envio precisa nascer na transação do dado de negócio.', 'INTEGRATION_DISPATCH_TRANSACTION_REQUIRED');
  if (!a.companyId) throw AppError.badRequest('Envio exige a empresa.', 'VALIDATION_ERROR');
  const operation = typeof a.operation === 'string' ? a.operation.trim() : '';
  const { connection, provider, def } = await resolveTarget({ companyId: a.companyId, connectionId: a.connectionId, domain: a.domain, operation }, a.transaction);
  const ctx = { groupId: connection.groupId, companyId: a.companyId, userId: a.userId || null };
  const opClass = resolveOpClass(def.opClass, a.opClass);

  let source = a.payload;
  let purpose = null;
  let fieldsDropped = null;
  if (def.outputMapper) {
    const m = await minimizePayload({ domain: provider.domain, operation, mapper: def.outputMapper }, a.payload || {}, ctx, a.transaction, { consentedFields: a.consentedFields });
    source = m.payload;
    purpose = m.purpose;
    fieldsDropped = m.fieldsDropped.length;
  }
  const snapshot = normalizeSnapshot(source);
  const problemas = validar(def.inputSchema, snapshot);
  if (problemas.length) throw payloadInvalid(problemas);

  const payloadHash = hashPayload(snapshot);
  const informada = typeof a.idempotencyKey === 'string' ? a.idempotencyKey.trim() : '';
  const key = informada || deriveIdempotencyKey({
    companyId: a.companyId, providerCode: connection.providerCode, operation, aggregateType: a.aggregateType, aggregateId: a.aggregateId, payloadHash,
  });
  const policy = await resolveEffectivePolicy(ctx, connection, a.transaction);
  const { dispatch, created } = await createDispatch(ctx, {
    connectionId: connection.id, operation, idempotencyKey: key, snapshot, criticalityOp: opClass, outboxEventId: a.outboxEventId,
    aggregateType: a.aggregateType, aggregateId: a.aggregateId, purpose, fieldsDropped, confirmationMode: def.confirmation, correlationId: a.correlationId, essential: a.essential === true, maxAttempts: policy.retry.max_attempts,
  }, a.transaction);
  if (!created && dispatch.payloadHash !== payloadHash) throw conflict();
  return { dispatchId: dispatch.id, status: dispatch.status, created, dispatch };
}

module.exports = { enqueue };
