'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Filas lidas: o outbox de eventos e a fila de envios de integração. Nome do assunto, tabela e a coluna de data de entrada na fila. */
const QUEUES = Object.freeze([
  { subject: 'outbox', table: 'integration.outbox_events', label: 'eventos do outbox' },
  { subject: 'dispatches', table: 'integration.dispatches', label: 'envios de integração' },
]);

async function counts(tenant, queue, cutoff, transaction) {
  const [row] = await sequelize.query(
    `SELECT count(*)::int AS pending, count(*) FILTER (WHERE created_at < :cutoff)::int AS old FROM ${queue.table} WHERE company_id = :companyId AND status = 'PENDING'`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, cutoff } }
  );
  return row;
}

/**
 * Fila acumulada (M9-D862 §3.3), por empresa: PENDING acima de `fila_max` OU ao menos `fila_antigos_min` eventos mais velhos que `fila_idade_min` minutos.
 * Um único evento velho NÃO dispara. Desperdício estimado 0 (informativo). Só lê as filas; o `outboxDispatcherJob` é quem as drena.
 */
async function detectQueueBacklog(tenant, now, params, transaction) {
  const cutoff = new Date(now.getTime() - params.queueAgeMin * 60000);
  const found = [];
  for (const queue of QUEUES) {
    const c = await counts(tenant, queue, cutoff, transaction);
    if (c.pending > params.queueMax || c.old >= params.queueOldMin) {
      found.push({
        subject: queue.subject, wasteCents: 0,
        evidence: { fila: queue.label, pendentes: c.pending, maisVelhosQueOLimite: c.old, idadeLimiteMin: params.queueAgeMin, limiteMaximo: params.queueMax, limiteDosVelhos: params.queueOldMin, informativo: true },
      });
    }
  }
  return found;
}

module.exports = { detectQueueBacklog, QUEUES };
