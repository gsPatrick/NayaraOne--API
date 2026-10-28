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

module.exports = { registerEventConsumer, runEventConsumers };
