'use strict';

/**
 * M9-D627 — Atendimento (crm.feedback_cases, M3-20):
 *  rm_support_complaints  por mês de abertura e motivo: reclamações e conflitos. O caso não tem coluna de motivo; o motivo é o TIPO do caso
 *                         (COMPLAINT ou CONFLICT). Elogio não conta.
 *  rm_support_sla         por mês: casos resolvidos (mês de resolved_at), resolvidos dentro do prazo (resolved_at <= sla_due_at) e casos em
 *                         aberto com prazo vencido (mês de sla_due_at, comparado com o relógio da passada). O vencimento muda sem evento:
 *                         a agenda reconfere os meses de prazo dos casos em aberto e dos alterados na janela.
 * Só ids e contagens: a descrição e a pessoa do caso não entram.
 */
const { MONTH_RE, sqlMonth, TZ, monthKey, rows } = require('./marketingAtendimento.time');

const REASONS = Object.freeze(['COMPLAINT', 'CONFLICT']);

function complaintsKey(event) {
  const p = event.payloadJson || event.payload || {};
  const reason = String(p.type || '').toUpperCase();
  return REASONS.includes(reason) ? { month: monthKey(event.occurredAt), reason } : null;
}

async function complaintsRecompute({ companyId, key, transaction }) {
  const [r] = await rows(
    `SELECT count(*)::int AS n FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL AND type = :reason AND ${sqlMonth('created_at')} = :month`,
    { ...TZ, companyId, reason: key.reason, month: key.month }, transaction
  );
  return { fields: { count: r.n } };
}

const complaintsKeysSql = (filter) => `SELECT DISTINCT ${sqlMonth('created_at')} AS month, type AS reason FROM crm.feedback_cases
  WHERE company_id = :companyId AND deleted_at IS NULL AND type IN (:reasons) ${filter} ORDER BY 1, 2`;

const complaintsScheduled = ({ companyId, now, windowDays, limit, transaction }) => rows(
  `${complaintsKeysSql('AND updated_at >= :since')} LIMIT :limit`, { ...TZ, companyId, reasons: REASONS, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000 }, transaction);
const complaintsRebuild = ({ companyId, transaction }) => rows(complaintsKeysSql(''), { ...TZ, companyId, reasons: REASONS }, transaction);

function slaKey(event) {
  const p = event.payloadJson || event.payload || {};
  const month = event.eventType === 'crm.feedback_case.resolved' ? monthKey(p.resolvedAt || event.occurredAt) : monthKey(p.slaDueAt || event.occurredAt);
  return MONTH_RE.test(String(month)) ? { month } : null;
}

async function slaRecompute({ companyId, key, now, transaction }) {
  const [r] = await rows(
    `SELECT count(*) FILTER (WHERE status = 'RESOLVED' AND ${sqlMonth('resolved_at')} = :month)::int AS resolved,
            count(*) FILTER (WHERE status = 'RESOLVED' AND ${sqlMonth('resolved_at')} = :month AND resolved_at <= sla_due_at)::int AS within_sla,
            count(*) FILTER (WHERE status <> 'RESOLVED' AND ${sqlMonth('sla_due_at')} = :month AND sla_due_at < :now)::int AS open_overdue
       FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL`,
    { ...TZ, companyId, month: key.month, now }, transaction
  );
  return { fields: { resolved: r.resolved, within_sla: r.within_sla, open_overdue: r.open_overdue } };
}

const slaKeysSql = (filter) => `
  SELECT ${sqlMonth('sla_due_at')} AS month FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL ${filter}
  UNION
  SELECT ${sqlMonth('resolved_at')} AS month FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL AND resolved_at IS NOT NULL ${filter}
  ORDER BY 1`;

const slaScheduled = ({ companyId, now, windowDays, limit, transaction }) => rows(
  `${slaKeysSql("AND (updated_at >= :since OR status <> 'RESOLVED')")} LIMIT :limit`, { ...TZ, companyId, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000 }, transaction);
const slaRebuild = ({ companyId, transaction }) => rows(slaKeysSql(''), { ...TZ, companyId }, transaction);

const complaints = {
  name: 'rm_support_complaints', keyColumns: ['month', 'reason'], eventTypes: ['crm.feedback_case.created'], aggregateKey: complaintsKey, recompute: complaintsRecompute,
  scheduledKeys: complaintsScheduled, rebuildKeys: complaintsRebuild,
};
const sla = {
  name: 'rm_support_sla', keyColumns: ['month'], eventTypes: ['crm.feedback_case.created', 'crm.feedback_case.resolved', 'crm.feedback_case.escalated'], aggregateKey: slaKey, recompute: slaRecompute,
  scheduledKeys: slaScheduled, rebuildKeys: slaRebuild,
};

module.exports = { complaints, sla, REASONS };
