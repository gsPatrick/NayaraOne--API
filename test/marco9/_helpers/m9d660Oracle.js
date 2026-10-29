'use strict';

// Oráculo da M9-D660: refaz cada número só com as linhas-fonte do Jurídico (consultas diretas às tabelas de origem, sem passar por read model nem fórmula).
const money = require('../../../src/features/analytics/metrics/formulas/money');

const TZ = 'America/Sao_Paulo';
const dayOf = (instant) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const dayNumber = (text) => Date.parse(`${text}T00:00:00Z`) / 86400000;

/** Prazos abertos: faixas disjuntas por dia de calendário de SP. */
async function deadlinesFromSource(env, t, asOf) {
  const [rows] = await env.admin.query("SELECT due_at FROM legal.legal_deadlines WHERE company_id = :c AND status = 'PENDING' AND deleted_at IS NULL", { replacements: { c: t.companyId } });
  const out = { next7: 0, to29: 0, overdue: 0, beyond: 0, oldest: null };
  for (const { due_at: due } of rows) {
    const diff = dayNumber(dayOf(due)) - dayNumber(asOf);
    if (diff < 0) { out.overdue += 1; out.oldest = Math.max(out.oldest || 0, -diff); } else if (diff <= 6) out.next7 += 1; else if (diff <= 29) out.to29 += 1; else out.beyond += 1;
  }
  return { ...out, total: out.next7 + out.to29 + out.overdue };
}

const FINISHED = ['CLOSED', 'ARCHIVED', 'CANCELLED'];

/** Processos ativos (status e fase fora da lista de encerrados), por nível de risco e valores. */
async function casesFromSource(env, t) {
  const [rows] = await env.admin.query(
    `SELECT COALESCE(NULLIF(upper(risk_level), ''), 'SEM_CLASSIFICACAO') AS risk, case_type AS type, estimated_amount::text AS estimated, confirmed_amount::text AS confirmed,
            (upper(status) NOT IN (:f) AND upper(COALESCE(phase, '')) NOT IN (:f)) AS active
       FROM legal.legal_cases WHERE company_id = :c AND deleted_at IS NULL`, { replacements: { c: t.companyId, f: FINISHED } }
  );
  const active = rows.filter((r) => r.active);
  const byRisk = {};
  for (const r of active) byRisk[r.risk] = (byRisk[r.risk] || 0) + 1;
  return {
    total: active.length, byRisk,
    estimated: money.money(money.sum(active.map((r) => r.estimated || 0))), confirmed: money.money(money.sum(rows.map((r) => r.confirmed || 0))),
    withoutValue: active.filter((r) => r.estimated === null).length,
  };
}

/** Exigências pendentes de contratos vivos, e em quantos contratos. */
async function missingFromSource(env, t) {
  const [[r]] = await env.admin.query(
    `SELECT count(*)::int AS requirements, count(DISTINCT q.contract_id)::int AS contracts, count(*) FILTER (WHERE c.starts_at IS NULL)::int AS without_deadline
       FROM legal.contract_requirements q JOIN legal.contracts c ON c.id = q.contract_id
      WHERE q.company_id = :c AND q.status = 'PENDING' AND c.deleted_at IS NULL AND c.status NOT IN ('CANCELLED', 'CLOSED')`, { replacements: { c: t.companyId } }
  );
  return r;
}

module.exports = { deadlinesFromSource, casesFromSource, missingFromSource, dayOf };
