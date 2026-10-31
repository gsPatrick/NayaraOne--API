'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const {
  COUNTED_MESSAGE_STATUSES, NOT_COUNTED_MESSAGE_STATUSES, RESERVED_ACTION_STATUSES, NON_TERMINAL_RUN_STATUSES, SEND_ACTION_TYPE,
} = require('./policy.statuses');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * Instantes das mensagens que contam para o frequency cap da pessoa no canal e finalidade, dentro de (from, to]:
 *  1. mensagens OUTBOUND automáticas em crm.messages (finalidade gravada) aceitas pelo provedor;
 *  2. ações SEND_MESSAGE já reservadas (PENDING ou OK) em runs não terminais que ainda não viraram mensagem (mesma action_key),
 *     para a corrida entre a checagem e a gravação da mensagem não furar o cap.
 */
async function listCountedSendTimes({ personId, channel, purpose, from, to }, tenant, transaction) {
  const base = { companyId: tenant.companyId, personId, channel, purpose, from, to };
  const messages = await run(
    `SELECT created_at AS at FROM crm.messages
      WHERE company_id = :companyId AND person_id = :personId AND channel = :channel AND purpose = :purpose
        AND direction = 'OUTBOUND' AND status IN (:counted) AND created_at > :from AND created_at <= :to`,
    { ...base, counted: COUNTED_MESSAGE_STATUSES }, transaction
  );
  // As ações reservadas saem primeiro (índice da pessoa) e a conferência "já virou mensagem" é feita pela chave, no índice único parcial (company_id, action_key). Um NOT EXISTS correlacionado
  // com o elemento do JSON levava o planejador a varrer crm.messages inteira (M9-D441).
  const candidates = await run(
    `SELECT (e->>'at')::timestamptz AS at, e->>'action_key' AS action_key
       FROM marketing.automation_runs r
       CROSS JOIN LATERAL jsonb_array_elements(r.actions_result) e
      WHERE r.company_id = :companyId AND r.subject_type = 'PERSON' AND r.subject_id = :personId AND r.status IN (:runStatuses)
        AND e->>'action_type' = :actionType AND e->>'status' IN (:reserved) AND e->>'channel' = :channel AND e->>'purpose' = :purpose
        AND (e->>'at')::timestamptz > :from AND (e->>'at')::timestamptz <= :to`,
    { ...base, runStatuses: NON_TERMINAL_RUN_STATUSES, actionType: SEND_ACTION_TYPE, reserved: RESERVED_ACTION_STATUSES }, transaction
  );
  const keys = [...new Set(candidates.map((c) => c.action_key).filter(Boolean))];
  const alreadyMessages = keys.length > 0
    ? new Set((await run('SELECT action_key FROM crm.messages WHERE company_id = :companyId AND action_key IN (:keys)', { companyId: tenant.companyId, keys }, transaction)).map((m) => m.action_key))
    : new Set();
  const reserved = candidates.filter((c) => !c.action_key || !alreadyMessages.has(c.action_key));
  return [...messages, ...reserved].map((r) => new Date(r.at));
}

/**
 * Horário (o da ação) da última mensagem aceita pelo provedor desta automação (todas as versões do fluxo) para a pessoa no canal,
 * até `to`. Conta run COMPLETED com ação SEND_MESSAGE OK cuja mensagem não falhou. Devolve Date ou null.
 */
async function lastAcceptedSendAt({ flowId, personId, channel, to }, tenant, transaction) {
  const [row] = await run(
    `SELECT max((e->>'at')::timestamptz) AS at
       FROM marketing.automation_runs r
       JOIN marketing.automation_versions v ON v.id = r.automation_version_id AND v.company_id = r.company_id
       CROSS JOIN LATERAL jsonb_array_elements(r.actions_result) e
       LEFT JOIN crm.messages m ON m.company_id = r.company_id AND m.action_key = e->>'action_key'
      WHERE r.company_id = :companyId AND v.flow_id = :flowId AND r.subject_type = 'PERSON' AND r.subject_id = :personId
        AND r.status = 'COMPLETED' AND e->>'action_type' = :actionType AND e->>'status' = 'OK' AND e->>'channel' = :channel
        AND (e->>'at')::timestamptz <= :to AND (m.id IS NULL OR m.status NOT IN (:notCounted))`,
    { companyId: tenant.companyId, flowId, personId, channel, to, actionType: SEND_ACTION_TYPE, notCounted: NOT_COUNTED_MESSAGE_STATUSES }, transaction
  );
  return row && row.at ? new Date(row.at) : null;
}

module.exports = { listCountedSendTimes, lastAcceptedSendAt };
