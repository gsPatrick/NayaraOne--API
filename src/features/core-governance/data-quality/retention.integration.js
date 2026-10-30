'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { readRetentionPayload, purgeExpired } = require('../../integrations/retention');

/**
 * Alvo INTEGRACAO (M9-D911 §3.3.5): o calendário de retenção das tabelas de integração. O descarte é feito SÓ por integration.purge_expired() (M9-D244, SECURITY DEFINER), com
 * os prazos dos parâmetros integration.* (saúde, erros, caixa de entrada, envios; o payload bruto de DEAD_LETTER por ATTEMPTS_EXHAUSTED fica
 * integration.inbox.dlq_retry_retention_days = 7 dias, M9-D212/D203). A simulação conta o que a função tocaria com os mesmos predicados, sem alterar nada.
 */
const count = async (sql, replacements, transaction) => Number((await sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements }))[0].n);
const older = (column, days) => `${column} < now() - make_interval(days => ${Number(days)})`;
const REDACTED = "payload_snapshot ? 'redacted' AND payload_snapshot = jsonb_build_object('redacted', true, 'hash', payload_hash::text)";

async function dryCounts(tenant, transaction) {
  const p = await readRetentionPayload(tenant, transaction);
  const r = { companyId: tenant.companyId };
  const c = (table, where) => count(`SELECT count(*)::int AS n FROM integration.${table} WHERE company_id = :companyId AND ${where}`, r, transaction);
  const counts = {
    providerHealth: await c('provider_health', `window_minutes > 0 AND ${older('window_start', p.health_days)}`),
    integrationErrors: await c('integration_errors', older('created_at', p.errors_days)),
    inboxRawCleared: await c('webhook_inbox', `status = 'PROCESSED' AND (payload_raw IS NOT NULL OR payload IS NOT NULL) AND ${older('received_at', p.inbox_raw_days)}`),
    dlqRawCleared: await c('webhook_inbox', `status = 'DEAD_LETTER' AND (payload_raw IS NOT NULL OR payload IS NOT NULL) AND ${older('received_at', p.inbox_dlq_raw_days)}`),
    inboxDeleted: await c('webhook_inbox i', `i.status IN ('PROCESSED', 'DEAD_LETTER') AND ${older('i.received_at', p.inbox_days)}
      AND NOT EXISTS (SELECT 1 FROM integration.integration_errors e WHERE e.company_id = i.company_id AND e.source = 'WEBHOOK' AND e.source_ref_id = i.id AND e.status IN ('OPEN', 'RETRYING'))`),
    dispatchesRedacted: await c('dispatches', `status IN ('CONFIRMED', 'CANCELLED') AND NOT (${REDACTED}) AND ${older('COALESCE(confirmed_at, updated_at)', p.dispatch_payload_days)}`),
    dispatchesDeleted: await c('dispatches', `status IN ('CONFIRMED', 'CANCELLED') AND ${older('COALESCE(confirmed_at, updated_at)', p.dispatch_days)}`),
  };
  return { counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0), effectiveDays: p };
}

/** Executa o descarte pela função única (a auditoria da execução é gravada por ela, na mesma transação). */
const purge = (tenant, transaction) => purgeExpired({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, transaction);

module.exports = { dryCounts, purge };
