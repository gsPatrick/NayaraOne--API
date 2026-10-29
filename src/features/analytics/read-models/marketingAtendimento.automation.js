'use strict';

/**
 * M9-D627 — rm_mkt_automation: por dia (SP), execuções iniciadas, bloqueadas e com falha das automações (marketing.automation_runs).
 * Executada = run iniciada no dia; bloqueada e falha = run nesse estado cujo fim (ou início, se ainda sem fim) caiu no dia. Falha de run
 * não tem evento (registro interno do M9-D434): entra pela agenda.
 */
const { sqlDay, TZ, dayKey, rows } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['automation.run.started', 'automation.run.completed', 'automation.run.blocked']);

const aggregateKey = (event) => ({ day: dayKey(event.occurredAt) });

async function recompute({ companyId, key, transaction }) {
  const [r] = await rows(
    `SELECT count(*) FILTER (WHERE ${sqlDay('started_at')} = :day)::int AS executed,
            count(*) FILTER (WHERE status = 'BLOCKED' AND ${sqlDay('COALESCE(finished_at, started_at)')} = :day)::int AS blocked,
            count(*) FILTER (WHERE status = 'FAILED' AND ${sqlDay('COALESCE(finished_at, started_at)')} = :day)::int AS failed
       FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL`,
    { ...TZ, companyId, day: key.day }, transaction
  );
  return { fields: { executed: r.executed, blocked: r.blocked, failed: r.failed } };
}

const KEYS_SQL = (filter) => `
  SELECT ${sqlDay('started_at')} AS day FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL ${filter}
  UNION
  SELECT ${sqlDay('finished_at')} AS day FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL AND finished_at IS NOT NULL ${filter}
  ORDER BY 1`;

async function scheduledKeys({ companyId, now, windowDays, limit, transaction }) {
  const since = new Date(now.getTime() - windowDays * 86400000);
  return rows(`${KEYS_SQL('AND updated_at >= :since')} LIMIT :limit`, { ...TZ, companyId, since, limit: limit || 5000 }, transaction);
}

const rebuildKeys = ({ companyId, transaction }) => rows(KEYS_SQL(''), { ...TZ, companyId }, transaction);

module.exports = { name: 'rm_mkt_automation', keyColumns: ['day'], eventTypes: EVENTS, aggregateKey, recompute, scheduledKeys, rebuildKeys };
