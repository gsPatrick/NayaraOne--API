'use strict';

const { loadConnection, loadHealthContext, statusOf } = require('./healthContext');
const { ensureCurrentRow, writeStatus, q, SELECT } = require('./healthStore');

/**
 * Resultado de um health check ativo (M9-D223 chama esta função): atualiza `last_check_*`, a contagem de falhas
 * seguidas (um sucesso zera), a cota que o fornecedor informou (se informou) e o estado de saúde. Não mexe no circuito (M9-D217 é a única dona das transições).
 * Devolve a linha atual (snake_case).
 */
async function recordHealthCheck(connectionId, { ok, latencyMs = null, at = new Date(), quota = null }, transaction) {
  const connection = await loadConnection(connectionId, transaction);
  await ensureCurrentRow(connection, at, transaction);
  const rows = await q(
    `UPDATE "integration"."provider_health" SET
       last_check_at = :at, last_check_ok = :ok, last_check_latency_ms = :lat,
       check_consecutive_failures = CASE WHEN :ok THEN 0 ELSE check_consecutive_failures + 1 END,
       check_consecutive_ok = CASE WHEN :ok THEN check_consecutive_ok + 1 ELSE 0 END,
       quota_limit = COALESCE(:qLimit, quota_limit), quota_remaining = COALESCE(:qRemaining, quota_remaining), quota_resets_at = COALESCE(:qResets, quota_resets_at),
       updated_at = :at
     WHERE connection_id = :id AND window_minutes = 0 RETURNING *`,
    {
      id: connectionId, at, ok: ok === true, lat: Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.round(Number(latencyMs))) : null,
      qLimit: quota?.limit ?? null, qRemaining: quota?.remaining ?? null, qResets: quota?.resetsAt ?? null,
    },
    transaction,
    SELECT,
  );
  const healthCtx = await loadHealthContext(connection, transaction);
  return writeStatus(connectionId, statusOf(rows[0], healthCtx, at), at, transaction);
}

module.exports = { recordHealthCheck };
