'use strict';

const { OutboxEvent } = require('../../src/models');
const { dispatchPendingInTransaction } = require('../../src/engines/events/outbox-dispatcher');

/**
 * Despacho do outbox de PRODUÇÃO (dispatchPendingInTransaction: publish + consumidores registrados + DISPATCHED) dentro da
 * transação do teste (com rollback), restrito aos eventos de `where` para não arrastar pendências de outros arquivos.
 */
function despacharNaTransacao(tenant, transaction, where) {
  return dispatchPendingInTransaction({ id: tenant.companyId }, transaction, { limit: 500, where });
}

/** Volta eventos já despachados para PENDING: simula o reenvio (o mesmo evento entregue de novo aos consumidores). */
async function reabrirEventos(ids, transaction) {
  await OutboxEvent.update({ status: 'PENDING', nextRetryAt: null }, { where: { id: ids }, transaction });
}

module.exports = { despacharNaTransacao, reabrirEventos };
