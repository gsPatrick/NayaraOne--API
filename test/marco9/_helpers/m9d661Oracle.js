'use strict';

// Oráculo da M9-D661: refaz cada número só com as linhas-fonte do Correspondente (consultas diretas às tabelas de origem, sem passar por read model nem fórmula).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { dayOf } = require('./m9d660Oracle');

const dayNumber = (text) => Date.parse(`${text}T00:00:00Z`) / 86400000;

/** Casos por estágio e a soma dos dias no estágio (última entrada aplicada no estágio atual; sem histórico, a última atualização do caso). */
async function stagesFromSource(env, t, asOf) {
  const [cases] = await env.admin.query('SELECT id, status, updated_at FROM correspondent.financing_cases WHERE company_id = :c', { replacements: { c: t.companyId } });
  const [history] = await env.admin.query('SELECT financing_case_id AS id, normalized_status AS status, occurred_at FROM correspondent.provider_status_history WHERE company_id = :c AND applied', { replacements: { c: t.companyId } });
  const out = {};
  for (const c of cases) {
    const entered = history.filter((h) => h.id === c.id && h.status === c.status).map((h) => new Date(h.occurred_at).getTime());
    const since = entered.length ? new Date(Math.max(...entered)) : new Date(c.updated_at);
    const slot = out[c.status] || (out[c.status] = { count: 0, days: 0 });
    slot.count += 1;
    slot.days += Math.max(0, dayNumber(asOf) - dayNumber(dayOf(since)));
  }
  return out;
}

/** Decisões do mês (a primeira aprovação ou rejeição de cada caso): por provider, aprovadas, rejeitadas, e os dias de calendário entre o envio e a decisão. */
async function decisionsFromSource(env, t, month) {
  const [rows] = await env.admin.query(
    `SELECT h.financing_case_id AS id, h.normalized_status AS outcome, h.occurred_at, fc.provider_code AS provider FROM correspondent.provider_status_history h
       JOIN correspondent.financing_cases fc ON fc.id = h.financing_case_id WHERE h.company_id = :c AND h.applied AND h.normalized_status IN ('APPROVED', 'REJECTED') ORDER BY h.occurred_at, h.id`, { replacements: { c: t.companyId } }
  );
  const [sent] = await env.admin.query("SELECT financing_case_id AS id, min(occurred_at) AS at FROM correspondent.provider_status_history WHERE company_id = :c AND applied AND normalized_status = 'SUBMITTED' GROUP BY 1", { replacements: { c: t.companyId } });
  const first = new Map();
  for (const r of rows) if (!first.has(r.id)) first.set(r.id, r);
  const out = { byProvider: {}, total: 0, days: 0, analysed: 0, noSendDate: 0 };
  for (const r of first.values()) {
    if (dayOf(r.occurred_at).slice(0, 7) !== month) continue;
    const p = out.byProvider[r.provider] || (out.byProvider[r.provider] = { approved: 0, rejected: 0 });
    if (r.outcome === 'APPROVED') p.approved += 1; else p.rejected += 1;
    out.total += 1;
    const s = sent.find((x) => x.id === r.id);
    if (!s) { out.noSendDate += 1; continue; }
    out.analysed += 1;
    out.days += dayNumber(dayOf(r.occurred_at)) - dayNumber(dayOf(s.at));
  }
  return out;
}

/** Comissão por status do direito (o ajustado fica fora). */
async function commissionFromSource(env, t) {
  const [rows] = await env.admin.query("SELECT status, COALESCE(SUM(amount), 0)::text AS total FROM correspondent.commission_entitlements WHERE company_id = :c AND status <> 'ADJUSTED' GROUP BY status", { replacements: { c: t.companyId } });
  const by = Object.fromEntries(rows.map((r) => [r.status, r.total]));
  const sum = (...s) => money.money(money.sum(s.map((x) => by[x] || 0)));
  const [expected, confirmed, received] = [sum('EXPECTED'), sum('CONFIRMED', 'RECEIVABLE', 'RECEIVED'), sum('RECEIVED')];
  return { expected, confirmed, received, toReceive: money.money(money.sub(confirmed, received)) };
}

module.exports = { stagesFromSource, decisionsFromSource, commissionFromSource };
