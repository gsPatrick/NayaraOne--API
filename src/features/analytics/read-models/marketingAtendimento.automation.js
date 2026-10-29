'use strict';

/**
 * M9-D627 — rm_mkt_automation: por dia (SP), execuções iniciadas, bloqueadas e com falha das automações (marketing.automation_runs).
 * Executada = run iniciada no dia; bloqueada e falha = run nesse estado cujo fim (ou início, se ainda sem fim) caiu no dia. Falha de run
 * não tem evento (registro interno do M9-D434): entra pela agenda.
 * M9-D671 acrescenta o detalhe do KPI "Automações bloqueadas e com falha": bloqueios por `blocked_reason` (QUIET_HOURS é adiamento, não bloqueio, e fica
 * de fora), bloqueios sem motivo (regra de qualidade), falhas por código de erro (o `error_code` da ação que falhou em `actions_result`; sem ele,
 * SEM_CODIGO) e o executado/bloqueado/falho de cada automação (o fluxo da versão da run).
 */
const { sqlDay, TZ, dayKey, rows } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['automation.run.started', 'automation.run.completed', 'automation.run.blocked']);
const QUIET_HOURS = 'QUIET_HOURS';
const NO_ERROR_CODE = 'SEM_CODIGO';

const aggregateKey = (event) => ({ day: dayKey(event.occurredAt) });
const FINISH_DAY = sqlDay('COALESCE(r.finished_at, r.started_at)');
const BLOCKED = `r.status = 'BLOCKED' AND COALESCE(r.blocked_reason, '') <> '${QUIET_HOURS}'`;
const toMap = (list, key, value) => Object.fromEntries(list.map((r) => [r[key], value(r)]));

async function recompute({ companyId, key, transaction }) {
  const args = { ...TZ, companyId, day: key.day };
  const [r] = await rows(
    `SELECT count(*) FILTER (WHERE ${sqlDay('started_at')} = :day)::int AS executed,
            count(*) FILTER (WHERE status = 'BLOCKED' AND ${sqlDay('COALESCE(finished_at, started_at)')} = :day)::int AS blocked,
            count(*) FILTER (WHERE status = 'FAILED' AND ${sqlDay('COALESCE(finished_at, started_at)')} = :day)::int AS failed
       FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL`,
    args, transaction
  );
  const reasons = await rows(
    `SELECT COALESCE(NULLIF(btrim(r.blocked_reason), ''), '') AS reason, count(*)::int AS n FROM marketing.automation_runs r
      WHERE r.company_id = :companyId AND r.deleted_at IS NULL AND ${BLOCKED} AND ${FINISH_DAY} = :day GROUP BY 1`,
    args, transaction
  );
  const codes = await rows(
    `SELECT COALESCE((SELECT NULLIF(btrim(a->>'error_code'), '') FROM jsonb_array_elements(r.actions_result) a WHERE a->>'status' = 'FAILED' AND NULLIF(btrim(a->>'error_code'), '') IS NOT NULL LIMIT 1), '${NO_ERROR_CODE}') AS code,
            count(*)::int AS n
       FROM marketing.automation_runs r WHERE r.company_id = :companyId AND r.deleted_at IS NULL AND r.status = 'FAILED' AND ${FINISH_DAY} = :day GROUP BY 1`,
    args, transaction
  );
  const flows = await rows(
    `SELECT COALESCE(v.flow_id::text, 'SEM_AUTOMACAO') AS flow, count(*) FILTER (WHERE ${sqlDay('r.started_at')} = :day)::int AS executed,
            count(*) FILTER (WHERE ${BLOCKED} AND ${FINISH_DAY} = :day)::int AS blocked, count(*) FILTER (WHERE r.status = 'FAILED' AND ${FINISH_DAY} = :day)::int AS failed
       FROM marketing.automation_runs r LEFT JOIN marketing.automation_versions v ON v.id = r.automation_version_id AND v.company_id = r.company_id
      WHERE r.company_id = :companyId AND r.deleted_at IS NULL GROUP BY 1`,
    args, transaction
  );
  const withoutReason = reasons.filter((x) => x.reason === '').reduce((acc, x) => acc + x.n, 0);
  return {
    fields: {
      executed: r.executed, blocked: r.blocked, failed: r.failed, blocked_without_reason: withoutReason,
      blocked_by_reason: toMap(reasons.filter((x) => x.reason !== ''), 'reason', (x) => x.n), failed_by_code: toMap(codes, 'code', (x) => x.n),
      by_automation: toMap(flows.filter((f) => f.executed || f.blocked || f.failed), 'flow', (f) => ({ executed: f.executed, blocked: f.blocked, failed: f.failed })),
    },
  };
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
