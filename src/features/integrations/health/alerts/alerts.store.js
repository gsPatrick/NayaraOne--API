'use strict';

const { q, SELECT } = require('../healthStore');

/**
 * Acesso SQL a integration.alerts (RLS FORCE por app.company_id). Linhas voltam em snake_case. A idempotência é do índice parcial único
 * (connection_id, alert_type, window_key) WHERE status = 'OPEN': inserir de novo a mesma condição aberta não cria linha.
 */
const findOpenForConnection = (connectionId, transaction) => q(
  `SELECT * FROM "integration"."alerts" WHERE connection_id = :id AND status = 'OPEN' ORDER BY opened_at, id FOR UPDATE`, { id: connectionId }, transaction, SELECT,
);

const findOpenForCompany = (companyId, transaction) => q(
  `SELECT * FROM "integration"."alerts" WHERE company_id = :c AND status = 'OPEN' ORDER BY opened_at, id`, { c: companyId }, transaction, SELECT,
);

/** Abre o alerta; devolve a linha criada ou null se a condição já tinha alerta aberto (corrida entre instâncias). */
async function insertOpen({ connection, condition, runbookPath, now }, transaction) {
  const rows = await q(
    `INSERT INTO "integration"."alerts" (group_id, company_id, connection_id, provider_code, alert_type, window_key, severity, details, runbook_path, opened_at, created_at, updated_at)
     VALUES (:g, :c, :id, :p, :t, :k, :s, CAST(:d AS jsonb), :rb, :now, :now, :now)
     ON CONFLICT (connection_id, alert_type, window_key) WHERE status = 'OPEN' DO NOTHING RETURNING *`,
    {
      g: connection.groupId, c: connection.companyId, id: connection.id, p: connection.providerCode, t: condition.type, k: condition.marker, s: condition.severity,
      d: JSON.stringify(condition.details), rb: runbookPath, now,
    },
    transaction,
    SELECT,
  );
  return rows[0] || null;
}

/** Marca o aviso feito (primeiro ou repetido) e atualiza a gravidade e os números da condição. */
async function markNotified(id, condition, now, transaction) {
  await q(
    `UPDATE "integration"."alerts" SET last_notified_at = :now, notify_count = notify_count + 1, severity = :s, details = CAST(:d AS jsonb), updated_at = :now WHERE id = :id`,
    { id, now, s: condition.severity, d: JSON.stringify(condition.details) }, transaction, 'UPDATE',
  );
}

/** Condição continua, mas dentro do prazo do antiflap: só atualiza os números (sem novo aviso). */
async function refresh(id, condition, now, transaction) {
  await q(
    `UPDATE "integration"."alerts" SET severity = :s, details = CAST(:d AS jsonb), updated_at = :now WHERE id = :id`,
    { id, now, s: condition.severity, d: JSON.stringify(condition.details) }, transaction, 'UPDATE',
  );
}

async function resolve(id, resolution, now, transaction) {
  await q(
    `UPDATE "integration"."alerts" SET status = 'RESOLVED', resolved_at = :now, resolution = :r, updated_at = :now WHERE id = :id AND status = 'OPEN'`,
    { id, r: resolution, now }, transaction, 'UPDATE',
  );
}

const markRecoveryNotified = (id, now, transaction) => q(
  `UPDATE "integration"."alerts" SET recovery_notified_at = :now, updated_at = :now WHERE id = :id`, { id, now }, transaction, 'UPDATE',
);

module.exports = { findOpenForConnection, findOpenForCompany, insertOpen, markNotified, refresh, resolve, markRecoveryNotified };
