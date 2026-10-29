'use strict';

// Oráculo da M9-D672: refaz cada número só com as linhas-fonte do Atendimento (consultas diretas às tabelas de origem, sem passar por read model nem fórmula).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { dayOf } = require('./m9d660Oracle');

const inMonth = (instant, month) => dayOf(instant).slice(0, 7) === month;

async function reviewsFromSource(env, t, month) {
  const [rows] = await env.admin.query("SELECT public_rating AS rating, COALESCE(completed_at, updated_at) AS at FROM marketing.review_requests WHERE company_id = :c AND deleted_at IS NULL AND status = 'COMPLETED' AND public_rating IS NOT NULL", { replacements: { c: t.companyId } });
  const mine = rows.filter((r) => inMonth(r.at, month));
  const sum = mine.reduce((a, r) => a + r.rating, 0);
  const byRating = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, mine.filter((r) => r.rating === n).length]));
  return { count: mine.length, sum, byRating, average: mine.length ? money.round(money.div(sum, mine.length), 2) : null };
}

async function satisfactionFromSource(env, t, month) {
  const [rows] = await env.admin.query('SELECT satisfaction_score AS score, COALESCE(completed_at, updated_at) AS at FROM marketing.review_requests WHERE company_id = :c AND deleted_at IS NULL AND satisfaction_score IS NOT NULL', { replacements: { c: t.companyId } });
  const mine = rows.filter((r) => inMonth(r.at, month));
  const sum = mine.reduce((a, r) => a + r.score, 0);
  const positive = mine.filter((r) => r.score >= 4).length;
  return { count: mine.length, average: money.round(money.div(sum, mine.length), 2), positivePct: money.round(money.mul(money.div(positive, mine.length), 100), 2) };
}

async function complaintsFromSource(env, t, month) {
  const [rows] = await env.admin.query("SELECT type, created_at AS at FROM crm.feedback_cases WHERE company_id = :c AND deleted_at IS NULL AND type IN ('COMPLAINT', 'CONFLICT')", { replacements: { c: t.companyId } });
  const out = {};
  for (const r of rows.filter((x) => inMonth(x.at, month))) out[r.type] = (out[r.type] || 0) + 1;
  return out;
}

const HOURS = { HIGH: 24, MEDIUM: 72, LOW: 120 };

/** Casos resolvidos no mês com (resolução − abertura) ≤ SLA da prioridade; maintenance_cases resolve na última alteração. */
async function slaFromSource(env, t, month, now) {
  const [fb] = await env.admin.query('SELECT severity, status, created_at, resolved_at AS done, status = \'RESOLVED\' AS finished FROM crm.feedback_cases WHERE company_id = :c AND deleted_at IS NULL', { replacements: { c: t.companyId } });
  const [mc] = await env.admin.query("SELECT severity, status, created_at, updated_at AS done, status IN ('RESOLVED', 'CLOSED') AS finished FROM construction.maintenance_cases WHERE company_id = :c AND deleted_at IS NULL", { replacements: { c: t.companyId } });
  const all = [...fb, ...mc];
  const limit = (c) => (HOURS[c.severity] || HOURS.MEDIUM) * 3600000;
  const resolved = all.filter((c) => c.finished && c.done && inMonth(c.done, month));
  const within = resolved.filter((c) => new Date(c.done) - new Date(c.created_at) <= limit(c));
  const openOverdue = all.filter((c) => !c.finished && new Date(c.created_at).getTime() + limit(c) < now.getTime() && inMonth(new Date(new Date(c.created_at).getTime() + limit(c)), month));
  return { resolved: resolved.length, within: within.length, openOverdue: openOverdue.length, pct: resolved.length ? money.round(money.mul(money.div(within.length, resolved.length), 100), 2) : null };
}

module.exports = { reviewsFromSource, satisfactionFromSource, complaintsFromSource, slaFromSource };
