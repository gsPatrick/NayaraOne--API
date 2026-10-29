'use strict';

const outbox = require('../../../../engines/events/outbox');
const adapterRegistry = require('../../registry/adapterRegistry');
const { moveTo } = require('../../inbox/inbox.worker');
const { validateEvent, readPayload } = require('./worker.validate');
const { decideOrder } = require('./worker.order');
const link = require('./worker.link');
const { getDomainHandler } = require('./worker.handlers');
const { PermanentWebhookFailure } = require('./worker.errors');

const AGGREGATE = 'IntegrationWebhookEvent';

/** Evento interno no outbox, na MESMA transação que marca a caixa de entrada como PROCESSED (M9-D212 3.2 item 3): leva só ids, status e o que o adapter separou. */
function publishInternal(ctx, row, ev, internalStatus, resourceRef, transaction) {
  return outbox.publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: AGGREGATE, aggregateId: row.id, eventType: ev.eventType,
    payload: { inboxId: row.id, providerCode: row.providerCode, externalEventId: row.externalEventId, resourceRef, status: internalStatus, data: ev.data || {} },
    idempotencyKey: `${ev.eventType}:${row.id}`, correlationId: row.correlationId || undefined, connectionId: row.connectionId || undefined,
  }, transaction);
}

/**
 * processEvent — UM evento pego pelo worker (M9-D212 3.2 itens 2 a 4): confere versão e esquema, converte para o evento interno, mapeia o status (desconhecido = STATUS_UNMAPPED),
 * decide a ordem (rank menor que o já aplicado = guardado com applied=false, sem chegar ao domínio), resolve o envio ligado, chama o tratador do domínio da família (se houver)
 * e publica no outbox. Tudo na transação recebida
 * (um SAVEPOINT por evento): qualquer erro desfaz o conjunto e o evento volta a FAILED. Dado inválido lança PermanentWebhookFailure.
 */
async function processEvent(ctx, row, transaction) {
  const adapter = adapterRegistry.instantiate(row.providerCode);
  const payload = readPayload(row);
  const { apiVersion, schema } = validateEvent(adapter, row, payload);
  const meta = { eventType: row.eventType, externalEventId: row.externalEventId, apiVersion };
  const ev = adapter.toInternalEvent(payload, meta);
  const internalStatus = ev.externalStatus ? adapter.mapStatus(ev.externalStatus) : null;
  if (ev.externalStatus && (internalStatus === null || internalStatus === undefined)) {
    throw new PermanentWebhookFailure('STATUS_UNMAPPED', 'O status informado pelo fornecedor não é reconhecido pelo adaptador.', { payload, schema });
  }
  const resourceRef = ev.resourceRef || null;
  const order = await decideOrder(ctx, row, { ranks: adapter.statusRank(), internalStatus, resourceRef }, transaction);
  let applied = order.applied;
  if (applied) {
    await link.linkToDispatch(ctx, row, ev, internalStatus, transaction);
    const tratador = getDomainHandler(adapter.constructor.domain);
    const r = tratador ? await tratador(ctx, row, { ...ev, internalStatus }, transaction) : null;
    if (r && r.applied === false) applied = false;
    if (applied) await publishInternal(ctx, row, ev, internalStatus, resourceRef, transaction);
  }
  await moveTo(ctx, row, 'PROCESSED', {
    processedAt: new Date(), apiVersion, resourceRef, internalStatus: internalStatus || null, statusRank: order.rank, applied,
  }, applied ? 'Evento convertido em evento interno.' : 'Evento guardado sem aplicar ao domínio (fora de ordem ou recusado pelo domínio).', transaction);
  return { applied };
}

module.exports = { processEvent };
