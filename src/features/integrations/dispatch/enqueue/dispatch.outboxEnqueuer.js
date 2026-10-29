'use strict';

const { registerDispatchEnqueuer, resetDispatchEnqueuer } = require('../../../../engines/events/dispatchGateway');
const { enqueue } = require('./dispatch.service');

/** O enqueuer que o outbox chama dentro da transação do despacho (M9-D204 e M9-D214): evento com destino externo vira 1 envio PENDING. */
async function outboxEnqueuer(args) {
  const r = await enqueue({
    companyId: args.companyId, connectionId: args.connectionId, domain: args.domain, operation: args.operation,
    aggregateType: args.aggregateType, aggregateId: args.aggregateId, payload: args.payload, idempotencyKey: args.idempotencyKey,
    correlationId: args.correlationId, outboxEventId: args.outboxEventId, transaction: args.transaction,
  });
  return { dispatchId: r.dispatchId, status: r.status };
}

const installOutboxEnqueuer = () => registerDispatchEnqueuer(outboxEnqueuer);

module.exports = { outboxEnqueuer, installOutboxEnqueuer, resetDispatchEnqueuer };
