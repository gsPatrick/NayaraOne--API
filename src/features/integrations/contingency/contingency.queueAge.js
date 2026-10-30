'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { QUEUED_STATUSES, EVENTS } = require('./contingency.constants');

/**
 * Itens da fila vencidos (M9-D226 3.3 item 1): envios PENDING ou RETRY_WAIT da connection criados há mais de `maxAgeH` horas e que ainda
 * não viraram tarefa manual (o evento `integration.contingency.manual_task:<envio>` é o marcador: uma tarefa por envio). Os mais antigos primeiro.
 * `extraStatuses`: estados que o domínio soma à fila (o pagamento UNKNOWN ou SUBMITTED sem status final do banco, M9-D228).
 */
async function findAgedQueued(ctx, connectionId, maxAgeH, now, limit, transaction, extraStatuses = []) {
  if (maxAgeH === null || maxAgeH === undefined) return [];
  const corte = new Date(now.getTime() - maxAgeH * 3600 * 1000);
  return sequelize.query(
    `SELECT d.id, d.operation, d.criticality_op AS "criticalityOp", d.created_at AS "createdAt", d.provider_code AS "providerCode", d.connection_id AS "connectionId"
       FROM "integration"."dispatches" d
      WHERE d.company_id = :companyId AND d.connection_id = :connectionId AND d.status IN (:statuses) AND d.created_at <= :corte
        AND NOT EXISTS (SELECT 1 FROM "integration"."outbox_events" e WHERE e.idempotency_key = :prefixo || d.id::text)
      ORDER BY d.created_at ASC, d.id ASC LIMIT :limit`,
    { replacements: { companyId: ctx.companyId, connectionId, statuses: [...QUEUED_STATUSES, ...extraStatuses], corte, prefixo: `${EVENTS.MANUAL_TASK}:`, limit }, type: QueryTypes.SELECT, transaction },
  );
}

/** Existe item vencido na fila (sem olhar se já virou tarefa)? Gatilho QUEUE_AGE_EXCEEDED. */
async function hasAgedQueued(ctx, connectionId, maxAgeH, now, transaction) {
  if (maxAgeH === null || maxAgeH === undefined) return false;
  const corte = new Date(now.getTime() - maxAgeH * 3600 * 1000);
  const rows = await sequelize.query(
    `SELECT 1 FROM "integration"."dispatches" WHERE company_id = :companyId AND connection_id = :connectionId AND status IN (:statuses) AND created_at <= :corte LIMIT 1`,
    { replacements: { companyId: ctx.companyId, connectionId, statuses: QUEUED_STATUSES, corte }, type: QueryTypes.SELECT, transaction },
  );
  return rows.length > 0;
}

module.exports = { findAgedQueued, hasAgedQueued };
