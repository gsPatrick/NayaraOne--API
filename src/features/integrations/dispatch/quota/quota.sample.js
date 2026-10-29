'use strict';

const { sequelize } = require('../../../../models');
const { registerHealthSampleSource } = require('../../health/sampleSources');

/**
 * Fonte das amostras de saúde (M9-D206) alimentada pelas tentativas de envio. Uma chamada conta como sucesso ou falha da
 * disponibilidade do fornecedor; erro de VALIDATION (dado nosso) não entra em `calls`; o limite do fornecedor (429) entra como falha, porque o
 * ritmo é nosso (M9-D225) e também é contado à parte em rateLimitCount. A cota devolvida é a última válida (renovação no futuro) ou a mais recente da janela.
 */
async function dispatchHealthSample({ connection, from, to }, transaction) {
  const q = (sql, rep) => sequelize.query(sql, { replacements: { id: connection.id, from, to, ...rep }, transaction }).then(([rows]) => rows);
  const [calls, counts, backlog, dlq, quota] = await Promise.all([
    q(`SELECT outcome, latency_ms, finished_at FROM "integration"."dispatch_attempts"
        WHERE connection_id = :id AND started_at >= :from AND started_at <= :to AND outcome IS NOT NULL
          AND COALESCE(error_class, '') <> 'VALIDATION'`),
    q(`SELECT count(*) FILTER (WHERE rate_limited)::int AS rate_limited, count(*) FILTER (WHERE error_class = 'AUTH')::int AS auth,
              count(*) FILTER (WHERE attempt_no > 1)::int AS retries, max(finished_at) AS last_at
         FROM "integration"."dispatch_attempts" WHERE connection_id = :id AND started_at >= :from AND started_at <= :to`),
    q(`SELECT count(*)::int AS n FROM "integration"."dispatches" WHERE connection_id = :id AND status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= :to`),
    q(`SELECT count(*)::int AS n FROM "integration"."dispatches" WHERE connection_id = :id AND status = 'DEAD_LETTER' AND updated_at >= :from AND updated_at <= :to`),
    q(`SELECT quota_limit, quota_remaining, quota_resets_at FROM "integration"."dispatch_attempts"
        WHERE connection_id = :id AND (quota_limit IS NOT NULL OR quota_remaining IS NOT NULL) AND (quota_resets_at > :to OR started_at >= :from)
        ORDER BY started_at DESC LIMIT 1`),
  ]);
  const c = counts[0];
  return {
    calls: calls.map((r) => ({ ok: r.outcome === 'SUCCESS', latencyMs: r.latency_ms })),
    rateLimitCount: c.rate_limited, authFailures: c.auth, retriesTotal: c.retries, dlqCount: dlq[0].n, backlogCount: backlog[0].n,
    quota: quota[0] ? { limit: quota[0].quota_limit, remaining: quota[0].quota_remaining, resetsAt: quota[0].quota_resets_at } : null,
    lastSampleAt: c.last_at,
  };
}

/** Liga a fonte ao agregador de saúde (chamada no boot do app). */
const registerDispatchHealthSource = () => registerHealthSampleSource(dispatchHealthSample);

module.exports = { dispatchHealthSample, registerDispatchHealthSource };
