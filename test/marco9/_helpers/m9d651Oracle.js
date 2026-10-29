'use strict';

// Cálculo INDEPENDENTE dos KPIs de atrasos, medições e não conformidades (M9-D651): lê só as linhas das fontes (etapas, medições e não conformidades, por
// conexão de superusuário), sem read model, worker nem fórmula do catálogo. Data de calendário de São Paulo feita na mão (UTC-3 fixo).
const money = require('../../../src/features/analytics/metrics/formulas/money');

const DAY = 86400000;
const spDay = (instant) => new Date(new Date(instant).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const between = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const rowsOf = async (env, sql, replacements) => (await env.admin.query(sql, { replacements }))[0];

async function delaysFacts(env, t, asOf) {
  const stages = await rowsOf(env, 'SELECT project_id::text AS project, ends_at, status, measured_pct::text AS measured FROM construction.project_stages WHERE company_id = :c AND deleted_at IS NULL', { c: t.companyId });
  const late = stages.filter((s) => s.ends_at && spDay(s.ends_at) < asOf && s.status !== 'DONE' && money.cmp(s.measured || 0, 100) < 0);
  const days = late.map((s) => between(spDay(s.ends_at), asOf));
  return {
    count: String(late.length), max: String(days.length ? Math.max(...days) : 0), projects: String(new Set(late.map((s) => s.project)).size),
    mean: days.length ? money.round(money.div(days.reduce((a, b) => a + b, 0), days.length), 1) : '0.0',
    withoutDate: stages.filter((s) => !s.ends_at && s.status !== 'DONE').length,
  };
}

async function measurementsFacts(env, t, asOf) {
  const rows = await rowsOf(env,
    `SELECT m.status, m.total_amount::text AS amount, COALESCE(m.submitted_at, m.created_at) AS sent, m.payable_financial_entry_id::text AS entry
       FROM construction.stage_measurements m JOIN construction.project_stages s ON s.id = m.project_stage_id WHERE m.company_id = :c AND s.company_id = :c`, { c: t.companyId });
  const sum = (list) => money.money(money.sum(list.map((r) => r.amount || 0)));
  const measured = rows.filter((r) => ['SUBMITTED', 'REVIEWED', 'APPROVED', 'PAYABLE'].includes(r.status));
  const approved = measured.filter((r) => ['APPROVED', 'PAYABLE'].includes(r.status));
  const pending = measured.filter((r) => ['SUBMITTED', 'REVIEWED'].includes(r.status));
  const oldest = pending.map((r) => spDay(r.sent)).sort()[0];
  return {
    measured: sum(measured), approved: sum(approved), pending: sum(pending), oldestAge: oldest ? String(between(oldest, asOf)) : null,
    withoutPayment: approved.filter((r) => !r.entry).length,
  };
}

async function nonconformityFacts(env, t, asOf) {
  const rows = await rowsOf(env, 'SELECT status, cause_code, created_at, closed_at FROM construction.nonconformities WHERE company_id = :c AND deleted_at IS NULL', { c: t.companyId });
  const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - 29 * DAY).toISOString().slice(0, 10);
  const inWindow = (instant) => instant && spDay(instant) >= from && spDay(instant) <= asOf;
  const open = rows.filter((r) => r.status !== 'CLOSED');
  const closed = rows.filter((r) => r.status === 'CLOSED' && inWindow(r.closed_at));
  const days = closed.map((r) => Math.max(0, between(spDay(r.created_at), spDay(r.closed_at))));
  const byCause = {};
  for (const r of open) byCause[(r.cause_code || 'NAO_INFORMADA').trim().toUpperCase()] = String(Number(byCause[(r.cause_code || 'NAO_INFORMADA').trim().toUpperCase()] || 0) + 1);
  return {
    open: String(open.length), opened: String(rows.filter((r) => inWindow(r.created_at)).length), closed: String(closed.length), byCause,
    mean: closed.length ? money.round(money.div(days.reduce((a, b) => a + b, 0), closed.length), 1) : null,
  };
}

module.exports = { delaysFacts, measurementsFacts, nonconformityFacts };
