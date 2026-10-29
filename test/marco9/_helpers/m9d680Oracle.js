'use strict';

// Oráculo da M9-D680: recalcula cada KPI SÓ com as linhas-fonte (sinais, outbox, inbox, provider_health, atualizações, erros, execuções bloqueadas, auditoria e envios) por consulta
// independente ao banco, sem passar pelos read models nem pelas fórmulas. Os números saem em texto decimal, como o KPI.
const env628 = require('./m9d628Env');

const TZ = 'America/Sao_Paulo';
const one = async (env, sql, replacements) => (await env.admin.query(sql, { replacements: { tz: TZ, ...replacements } }))[0][0];
/** Percentual com 2 casas, meio para cima, só com inteiros (BigInt): num / den x 100. */
function pct(num, den) {
  const n = BigInt(num); const d = BigInt(den);
  if (d === 0n) return null;
  const scaled = (n * 20000n + d) / (2n * d);
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
}

/** Disponibilidade do mês de SP até a data-base: ok / esperadas, com as esperadas = (dia inteiro | até agora) / intervalo. */
async function availability(env, { asOf, now, intervalS, probes }) {
  const rows = (await env.admin.query(
    `SELECT probe, to_char((occurred_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS day, count(*)::int AS checks, count(*) FILTER (WHERE ok)::int AS up
       FROM analytics.tech_signal_log WHERE kind = 'PROBE' AND probe IN (:probes) AND occurred_at <= :now
        AND (occurred_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:asOf AS date) GROUP BY 1, 2`,
    { replacements: { tz: TZ, probes, now, asOf, from: `${asOf.slice(0, 7)}-01` } }
  ))[0];
  const elapsed = (await one(env, "SELECT EXTRACT(EPOCH FROM (CAST(:now AS timestamptz) - (CAST(:asOf AS date)::timestamp AT TIME ZONE :tz)))::int AS s", { now, asOf })).s;
  let expected = 0; let checks = 0; let up = 0;
  for (const r of rows) {
    const e = Math.max(r.day === asOf ? Math.floor(elapsed / intervalS) : Math.floor(86400 / intervalS), r.checks);
    expected += e; checks += r.checks; up += r.up;
  }
  return { expected, checks, up, missing: expected - checks, value: pct(up, expected) };
}

/** Filas do outbox e da inbox da empresa. `only` restringe aos tipos de evento / consumidores dados (o próprio BI publica eventos no outbox ao atualizar, então a conta total muda a cada passada). */
async function queues(env, t, now, only = null) {
  const filter = (col) => (only ? ` AND ${col} IN (:only)` : '');
  const o = await one(env, `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS depth, count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dlq, min(created_at) FILTER (WHERE status = 'PENDING') AS oldest FROM integration.outbox_events WHERE company_id = :c${filter('event_type')}`, { c: t.companyId, only });
  const i = await one(env, `SELECT count(*) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING', 'FAILED'))::int AS depth, count(*) FILTER (WHERE status = 'DEAD')::int AS dlq, min(created_at) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING', 'FAILED')) AS oldest FROM integration.integration_inbox WHERE company_id = :c${filter('consumer_name')}`, { c: t.companyId, only });
  const ages = [o.oldest, i.oldest].filter(Boolean).map((d) => Math.floor((now.getTime() - new Date(d).getTime()) / 1000));
  return { depth: o.depth + i.depth, dlq: o.dlq + i.dlq, oldestSeconds: ages.length ? Math.max(...ages) : null };
}

async function integrations(env, t, windowMinutes) {
  const r = await one(env, `WITH last AS (SELECT DISTINCT ON (h.connection_id, h.window_minutes) h.* FROM integration.provider_health h JOIN integration.connections c ON c.id = h.connection_id AND c.status = 'ACTIVE'
      WHERE h.company_id = :c AND h.window_minutes = :w ORDER BY h.connection_id, h.window_minutes, h.window_start DESC)
    SELECT COALESCE(sum(calls_total), 0)::int AS calls, COALESCE(sum(calls_failed), 0)::int AS errors FROM last`, { c: t.companyId, w: windowMinutes });
  return { ...r, value: r.calls === 0 ? null : pct(r.errors, r.calls) };
}

/** Falhas de autenticação do dia SP: login e MFA (sinais) e de integração (erros AUTH). */
async function authFailures(env, t, asOf) {
  const s = await one(env, `SELECT count(*) FILTER (WHERE kind = 'LOGIN_FAILURE')::int AS login, count(*) FILTER (WHERE kind = 'MFA_FAILURE')::int AS mfa FROM analytics.tech_signal_log
      WHERE kind IN ('LOGIN_FAILURE', 'MFA_FAILURE') AND (occurred_at AT TIME ZONE :tz)::date = CAST(:d AS date)`, { d: asOf });
  const e = await one(env, "SELECT count(*)::int AS n FROM integration.integration_errors WHERE company_id = :c AND error_class = 'AUTH' AND (created_at AT TIME ZONE :tz)::date = CAST(:d AS date)", { c: t.companyId, d: asOf });
  return { login: s.login, mfa: s.mfa, integration: e.n, total: s.login + s.mfa + e.n };
}

/** Eventos bloqueados do dia SP, por motivo (as três fontes). */
async function blocked(env, t, asOf) {
  const day = (col) => `(${col} AT TIME ZONE :tz)::date = CAST(:d AS date)`;
  const r = await one(env, `SELECT
      (SELECT count(*)::int FROM marketing.automation_runs WHERE company_id = :c AND status = 'BLOCKED' AND ${day('started_at')}) AS automation,
      (SELECT count(*)::int FROM audit.audit_log WHERE company_id = :c AND action LIKE '%.blocked' AND ${day('occurred_at')}) AS security,
      (SELECT count(*)::int FROM integration.dispatches WHERE company_id = :c AND last_error_class = 'VALIDATION' AND status IN ('FAILED', 'DEAD_LETTER') AND ${day('updated_at')}) AS validation`, { c: t.companyId, d: asOf });
  return { ...r, total: r.automation + r.security + r.validation };
}

module.exports = { availability, queues, integrations, authFailures, blocked, env628 };
