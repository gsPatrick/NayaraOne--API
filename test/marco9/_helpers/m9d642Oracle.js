'use strict';

// Oráculo da M9-D642: refaz cada número só com as linhas-fonte da Locação (consultas diretas às tabelas de origem, sem passar por read model nem fórmula). Datas de calendário de
// São Paulo; os arredondamentos do teste usam valores que não caem em meio exato.
const { dayOf } = require('./m9d660Oracle');

const LEASE = ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'];
const dayNumber = (text) => Math.round(Date.parse(`${text}T00:00:00Z`) / 86400000);
const LEASE_PERSONS = 'SELECT cp.person_id FROM legal.contract_parties cp JOIN legal.contracts c ON c.id = cp.contract_id WHERE cp.company_id = :c AND cp.deleted_at IS NULL AND c.deleted_at IS NULL AND c.contract_type IN (:lease)';

async function ticketsFromSource(env, t, asOf) {
  const [rows] = await env.admin.query(
    `SELECT m.status, m.created_at AS created, m.updated_at AS updated FROM construction.maintenance_cases m WHERE m.company_id = :c AND m.deleted_at IS NULL
        AND m.property_id IN (SELECT property_id FROM legal.contracts WHERE company_id = :c AND deleted_at IS NULL AND property_id IS NOT NULL AND contract_type IN (:lease))`, { replacements: { c: t.companyId, lease: LEASE } }
  );
  const start = dayNumber(`${asOf.slice(0, 7)}-01`);
  const end = dayNumber(asOf);
  const inPeriod = (instant) => { const d = dayNumber(dayOf(instant)); return d >= start && d <= end; };
  const closed = rows.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status) && inPeriod(r.updated));
  const hours = closed.reduce((sum, r) => sum + (new Date(r.updated) - new Date(r.created)) / 3600000, 0);
  return {
    open: rows.filter((r) => ['OPEN', 'IN_PROGRESS'].includes(r.status)).length, opened: rows.filter((r) => inPeriod(r.created)).length, closed: closed.length,
    hours, average: closed.length ? Math.round((hours / closed.length) * 10) / 10 : null,
  };
}

async function satisfactionFromSource(env, t, asOf, scores = { COMPLIMENT: 5, COMPLAINT: 1, CONFLICT: 3 }) {
  const month = asOf.slice(0, 7);
  const [rows] = await env.admin.query(`SELECT person_id AS person, type, created_at AS created FROM crm.feedback_cases WHERE company_id = :c AND deleted_at IS NULL AND person_id IN (${LEASE_PERSONS})`, { replacements: { c: t.companyId, lease: LEASE } });
  const [parties] = await env.admin.query(`SELECT cp.person_id AS person, cp.party_role AS role FROM legal.contract_parties cp JOIN legal.contracts c ON c.id = cp.contract_id WHERE cp.company_id = :c AND cp.deleted_at IS NULL AND c.deleted_at IS NULL AND c.contract_type IN (:lease)`, { replacements: { c: t.companyId, lease: LEASE } });
  const rolesOf = (person) => new Set(parties.filter((p) => p.person === person).map((p) => p.role));
  const inMonth = rows.filter((r) => dayOf(r.created).slice(0, 7) === month);
  const group = (list) => ({ responses: list.length, sum: list.reduce((s, r) => s + scores[r.type], 0) });
  const avg = (g) => (g.responses ? Math.round((g.sum / g.responses) * 100) / 100 : null);
  const all = group(inMonth); const tenant = group(inMonth.filter((r) => rolesOf(r.person).has('TENANT'))); const owner = group(inMonth.filter((r) => rolesOf(r.person).has('LANDLORD')));
  return { all, tenant, owner, average: avg(all), tenantAverage: avg(tenant), ownerAverage: avg(owner) };
}

const lastDayPlus = (month, days) => { const [y, m] = month.split('-').map(Number); return dayNumber(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)) + days; };

async function repassesFromSource(env, t, asOf, repassDays = 10) {
  const [rows] = await env.admin.query(`SELECT status, net_amount::text AS amount, reference_month AS month, paid_at AS paid FROM finance.owner_repasses WHERE company_id = :c AND status <> 'CANCELLED'`, { replacements: { c: t.companyId } });
  const today = dayNumber(asOf);
  const first = dayNumber(`${asOf.slice(0, 7)}-01`);
  const cents = (r) => Math.round(Number(r.amount) * 100);
  const withDue = rows.map((r) => ({ ...r, due: /^\d{4}-(0[1-9]|1[0-2])$/.test(r.month || '') ? lastDayPlus(r.month, repassDays) : null }));
  const pending = withDue.filter((r) => ['PENDING', 'APPROVED'].includes(r.status));
  const overdue = pending.filter((r) => r.due !== null && r.due < today);
  const paid = withDue.filter((r) => r.status === 'PAID' && r.paid && dayOf(r.paid).slice(0, 7) === asOf.slice(0, 7));
  const due = withDue.filter((r) => r.due !== null && r.due >= first && r.due <= today);
  const onTime = due.filter((r) => r.status === 'PAID' && r.paid && dayNumber(dayOf(r.paid)) <= r.due);
  return {
    overdue: overdue.length, overdueCents: overdue.reduce((s, r) => s + cents(r), 0), paid: paid.length, paidCents: paid.reduce((s, r) => s + cents(r), 0),
    pendingOnTime: pending.length - overdue.length - pending.filter((r) => r.due === null).length, due: due.length, onTime: onTime.length,
    onTimePct: due.length ? Math.round((onTime.length / due.length) * 10000) / 100 : null, withoutDue: [...pending, ...paid].filter((r) => r.due === null).length,
  };
}

module.exports = { ticketsFromSource, satisfactionFromSource, repassesFromSource, LEASE };
