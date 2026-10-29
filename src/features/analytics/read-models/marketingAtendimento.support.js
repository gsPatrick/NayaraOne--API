'use strict';

/**
 * M9-D627 — Atendimento (crm.feedback_cases, M3-20):
 *  rm_support_complaints  por mês de abertura e motivo: reclamações e conflitos. O caso não tem coluna de motivo; o motivo é o TIPO do caso
 *                         (COMPLAINT ou CONFLICT); tipo desconhecido vai ao motivo SEM_MOTIVO (M9-D672). Elogio não conta.
 *  rm_support_sla         fica em marketingAtendimento.sla.js (SLA por prioridade, M9-D672).
 * Só ids e contagens: a descrição e a pessoa do caso não entram.
 */
const { sqlMonth, TZ, monthKey, rows } = require('./marketingAtendimento.time');
const { sla } = require('./marketingAtendimento.sla');

const REASONS = Object.freeze(['COMPLAINT', 'CONFLICT']);
const NO_REASON = 'SEM_MOTIVO'; // M9-D672: caso que não é elogio nem tem tipo conhecido
const KNOWN_TYPES = Object.freeze(['COMPLAINT', 'COMPLIMENT', 'CONFLICT']);

function complaintsKey(event) {
  const p = event.payloadJson || event.payload || {};
  const type = String(p.type || '').toUpperCase();
  if (!type || type === 'COMPLIMENT') return null;
  return { month: monthKey(event.occurredAt), reason: REASONS.includes(type) ? type : NO_REASON };
}

async function complaintsRecompute({ companyId, key, transaction }) {
  const [r] = await rows(
    `SELECT count(*)::int AS n FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL AND ${sqlMonth('created_at')} = :month
        AND ${key.reason === NO_REASON ? 'type NOT IN (:known)' : 'type = :reason'}`,
    { ...TZ, companyId, reason: key.reason, month: key.month, known: KNOWN_TYPES }, transaction
  );
  return { fields: { count: r.n } };
}

const complaintsKeysSql = (filter) => `SELECT DISTINCT ${sqlMonth('created_at')} AS month, CASE WHEN type IN (:reasons) THEN type ELSE '${NO_REASON}' END AS reason FROM crm.feedback_cases
  WHERE company_id = :companyId AND deleted_at IS NULL AND type <> 'COMPLIMENT' ${filter} ORDER BY 1, 2`;

const complaintsScheduled = ({ companyId, now, windowDays, limit, transaction }) => rows(
  `${complaintsKeysSql('AND updated_at >= :since')} LIMIT :limit`, { ...TZ, companyId, reasons: REASONS, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000 }, transaction);
const complaintsRebuild = ({ companyId, transaction }) => rows(complaintsKeysSql(''), { ...TZ, companyId, reasons: REASONS }, transaction);

const complaints = {
  name: 'rm_support_complaints', keyColumns: ['month', 'reason'], eventTypes: ['crm.feedback_case.created'], aggregateKey: complaintsKey, recompute: complaintsRecompute,
  scheduledKeys: complaintsScheduled, rebuildKeys: complaintsRebuild,
};

module.exports = { complaints, sla, REASONS, NO_REASON };
