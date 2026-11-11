'use strict';

// Oráculo da M9-D641: refaz cada número só com as linhas-fonte da Locação (consultas diretas às tabelas de origem, sem passar por read model nem fórmula). Datas de
// calendário de São Paulo; hoje+N é aritmética de calendário.
const { dayOf } = require('./m9d660Oracle');

const dayNumber = (text) => Math.round(Date.parse(`${text}T00:00:00Z`) / 86400000);
const LEASE = ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'];

async function guaranteesFromSource(env, t, asOf, noExpiry = ['SECURITY_DEPOSIT']) {
  const [rows] = await env.admin.query(
    `SELECT g.guarantee_type AS type, g.ends_at::text AS ends FROM legal.guarantees g JOIN legal.contracts c ON c.id = g.contract_id
      WHERE g.company_id = :c AND g.deleted_at IS NULL AND g.status = 'ACTIVE' AND c.deleted_at IS NULL AND c.status = 'ACTIVE' AND c.contract_type IN (:lease)`, { replacements: { c: t.companyId, lease: LEASE } }
  );
  const today = dayNumber(asOf);
  const out = { in30: 0, in60: 0, expired: 0, withoutDate: 0 };
  for (const r of rows) {
    if (!r.ends) { if (!noExpiry.includes(r.type)) out.withoutDate += 1; continue; }
    const delta = dayNumber(r.ends) - today;
    if (delta < 0) out.expired += 1;
    else { if (delta <= 29) out.in30 += 1; if (delta <= 59) out.in60 += 1; }
  }
  return out;
}

/** Abertas = exigência PENDING e troca de titularidade exigida e sem comprovante, de contratos de locação não encerrados; o prazo é o início do contrato (dia de SP). */
async function obligationsFromSource(env, t, asOf) {
  const [req] = await env.admin.query("SELECT c.starts_at AS due FROM legal.contract_requirements r JOIN legal.contracts c ON c.id = r.contract_id WHERE r.company_id = :c AND r.status = 'PENDING' AND c.deleted_at IS NULL AND c.contract_type IN (:lease) AND c.status NOT IN ('TERMINATED', 'CLOSED')", { replacements: { c: t.companyId, lease: LEASE } });
  const [uti] = await env.admin.query("SELECT c.starts_at AS due FROM legal.lease_obligations u JOIN legal.contracts c ON c.id = u.contract_id WHERE u.company_id = :c AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND u.transfer_required AND u.evidence_file_id IS NULL AND c.deleted_at IS NULL AND c.contract_type IN (:lease) AND c.status NOT IN ('TERMINATED', 'CLOSED')", { replacements: { c: t.companyId, lease: LEASE } });
  const today = dayNumber(asOf);
  const all = [...req, ...uti];
  const days = all.filter((r) => r.due).map((r) => today - dayNumber(dayOf(r.due))).filter((d) => d > 0);
  return { open: all.length, overdue: days.length, upcoming: all.length - days.length - all.filter((r) => !r.due).length, withoutDeadline: all.filter((r) => !r.due).length, oldest: days.length ? Math.max(...days) : null };
}

async function inspectionsKeysFromSource(env, t, asOf) {
  const today = dayNumber(asOf);
  const [ins] = await env.admin.query("SELECT i.scheduled_at AS at FROM legal.inspections i JOIN legal.contracts c ON c.id = i.contract_id WHERE i.company_id = :c AND i.deleted_at IS NULL AND c.deleted_at IS NULL AND c.contract_type IN (:lease) AND i.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')", { replacements: { c: t.companyId, lease: LEASE } });
  const [keys] = await env.admin.query("SELECT c.ends_at AS ends FROM legal.key_deliveries k JOIN legal.contracts c ON c.id = k.contract_id WHERE k.company_id = :c AND k.deleted_at IS NULL AND k.status = 'RELEASED' AND c.status = 'ACTIVE' AND c.deleted_at IS NULL AND c.contract_type IN (:lease)", { replacements: { c: t.companyId, lease: LEASE } });
  return {
    pending: ins.length, overdue: ins.filter((r) => r.at && dayNumber(dayOf(r.at)) < today).length,
    keysOut: keys.length, keysOverdue: keys.filter((r) => r.ends && dayNumber(dayOf(r.ends)) < today).length, keysWithoutDate: keys.filter((r) => !r.ends).length,
  };
}

module.exports = { guaranteesFromSource, obligationsFromSource, inspectionsKeysFromSource };
