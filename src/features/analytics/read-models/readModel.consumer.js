'use strict';

/**
 * M9-D607 (3.2 passo 1 e 8) — liga o worker ao outbox: um consumidor por tipo de evento dos read models registrados (o worker decide
 * quais projeções atualizar) e o fim de lote do despacho. Na ÚLTIMA tentativa permitida pelo backoff do outbox, a falha marca os
 * read models do evento como DEGRADED antes de o evento seguir para a DLQ.
 */
const { registerEventConsumer, registerBatchEndHandler } = require('../../../engines/events/consumers');
const { getOutboxBackoff } = require('../../../engines/events/outboxBackoff');
const { setConsumerInstaller, modelsFor } = require('./readModel.registry');
const { applyEvent } = require('./readModel.worker');
const { flushBatch } = require('./readModel.batch');
const { markDegraded } = require('./readModel.degraded');

const CONSUMER_NAME = 'analytics.read-model.worker';

async function isFinalAttempt(event, transaction) {
  const backoff = await getOutboxBackoff({ id: event.companyId }, transaction);
  return (event.retryCount || 0) + 1 >= backoff.length;
}

async function workerConsumer(event, transaction) {
  try {
    return await applyEvent(event, transaction);
  } catch (err) {
    if (await isFinalAttempt(event, transaction)) await markDegraded(event, modelsFor(event.eventType), err);
    throw err;
  }
}

function install() {
  setConsumerInstaller((eventType) => registerEventConsumer(eventType, CONSUMER_NAME, workerConsumer));
  registerBatchEndHandler(CONSUMER_NAME, (transaction) => flushBatch(transaction));
}

module.exports = { install, workerConsumer, CONSUMER_NAME };
