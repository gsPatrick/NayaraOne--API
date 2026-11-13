'use strict';

const { sequelize } = require('../../models');

/**
 * Registro de consumidores de eventos do outbox. Cada módulo registra (eventType, nome, função); o dispatcher chama
 * runEventConsumers(event, transaction) depois de publicar. Cada consumidor roda num savepoint: se falhar, o erro propaga (o
 * dispatcher agenda nova tentativa) sem deixar a transação do lote em estado abortado. Consumidor tem de ser idempotente.
 */
const consumers = new Map();

function registerEventConsumer(eventType, name, fn) {
  const list = consumers.get(eventType) || [];
  if (!list.some((c) => c.name === name)) list.push({ name, fn });
  consumers.set(eventType, list);
}

async function runEventConsumers(event, transaction) {
  const ran = [];
  for (const { name, fn } of consumers.get(event.eventType) || []) {
    await sequelize.transaction({ transaction }, async (savepoint) => fn(event, savepoint));
    ran.push(name);
  }
  return ran;
}

/**
 * Entrega imediata a UM consumidor registrado, na transação de quem publicou (verificação independente do Marco 6, M6-21):
 * a medição aprovada só vira PAYABLE com a conta a pagar criada pelo consumidor do Financeiro, no mesmo commit — nenhuma
 * medição aprovada fica sem conta. O evento continua PENDING no outbox: o despachante o entrega depois a todos os
 * consumidores, e o do Financeiro, idempotente por source_event_id, devolve a conta já criada. Devolve o retorno do
 * consumidor; consumidor não registrado é erro (falha fechada).
 */
async function runNamedConsumer(event, name, transaction) {
  const consumer = (consumers.get(event.eventType) || []).find((c) => c.name === name);
  if (!consumer) throw new Error(`Consumidor "${name}" não registrado para ${event.eventType}.`);
  return consumer.fn(event, transaction); // sem savepoint: a falha desfaz a operação inteira de quem publicou
}

/**
 * Fim de lote (M9-D607): quem precisa fechar algo POR LOTE (e não por evento) registra aqui. O dispatcher chama runBatchEnd ao terminar
 * os eventos de uma empresa, ainda na transação do lote; cada handler roda num savepoint e a falha dele é só registrada (nunca desfaz
 * o despacho dos eventos).
 */
const batchEndHandlers = new Map();

function registerBatchEndHandler(name, fn) {
  if (!batchEndHandlers.has(name)) batchEndHandlers.set(name, fn);
}

async function runBatchEnd(transaction) {
  for (const [name, fn] of batchEndHandlers) {
    try {
      await sequelize.transaction({ transaction }, async (savepoint) => fn(savepoint));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[EventsEngine] Falha no fim de lote "${name}": ${err.message}`);
    }
  }
}

module.exports = { registerEventConsumer, runEventConsumers, runNamedConsumer, registerBatchEndHandler, runBatchEnd };
