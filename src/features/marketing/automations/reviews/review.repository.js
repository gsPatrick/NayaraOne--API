'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const COLUMNS = `id, group_id, company_id, person_id, source_entity_type, source_entity_id, satisfaction_score, platform, public_rating, completed_at, status, feedback_case_id,
  channel, sent_at, idempotency_key, error_code, tracking_link_id, message_id`;

/** Serializa os pedidos da MESMA pessoa na transação: dois eventos de satisfação ao mesmo tempo viram um pedido (o segundo espera e enxerga o primeiro). */
const lockPerson = (personId, transaction) => sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended('marketing.review:' || :p, 0))", { replacements: { p: personId }, transaction });

const findByKey = async (key, transaction) => (await run(`SELECT ${COLUMNS} FROM marketing.review_requests WHERE idempotency_key = :key AND deleted_at IS NULL`, { key }, transaction))[0] || null;
const findOne = async (id, transaction, lock = false) => (await run(`SELECT ${COLUMNS} FROM marketing.review_requests WHERE id = :id AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, { id }, transaction))[0] || null;
const findByOrigin = async (personId, type, id, transaction) => (await run(`SELECT ${COLUMNS} FROM marketing.review_requests WHERE person_id = :personId AND source_entity_type = :type AND source_entity_id = :id AND deleted_at IS NULL`,
  { personId, type, id }, transaction))[0] || null;

/** Caso de reclamação, elogio ou conflito do CRM ainda aberto (OPEN, IN_PROGRESS ou ESCALATED) da pessoa: qualquer um bloqueia o pedido. */
async function hasOpenCase(personId, transaction) {
  return (await run("SELECT 1 AS ok FROM crm.feedback_cases WHERE person_id = :p AND status IN ('OPEN','IN_PROGRESS','ESCALATED') AND deleted_at IS NULL LIMIT 1", { p: personId }, transaction)).length > 0;
}

async function insert(tenant, actor, v, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.review_requests (group_id, company_id, person_id, source_entity_type, source_entity_id, satisfaction_score, platform, status, feedback_case_id, channel, idempotency_key, error_code, created_by, updated_by)
     VALUES (:g, :c, :person, :type, :sid, :score, :platform, :status, :caseId, :channel, :key, :errorCode, :actor, :actor)
     ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
    { g: tenant.groupId, c: tenant.companyId, person: v.personId, type: v.sourceType, sid: v.sourceId, score: v.score, platform: v.platform || null, status: v.status, caseId: v.feedbackCaseId || null,
      channel: v.channel, key: v.key, errorCode: v.errorCode || null, actor: actor || null }, transaction
  );
  return row || null;
}

const SETTABLE = { status: 'status', errorCode: 'error_code', trackingLinkId: 'tracking_link_id', messageId: 'message_id', sentAt: 'sent_at', platform: 'platform', publicRating: 'public_rating', completedAt: 'completed_at', channel: 'channel' };
async function update(id, fields, actor, transaction) {
  const keys = Object.keys(fields).filter((k) => SETTABLE[k]);
  const sets = keys.map((k) => `${SETTABLE[k]} = :${k}`).join(', ');
  const [row] = await run(`UPDATE marketing.review_requests SET ${sets}, updated_by = :actor, updated_at = now() WHERE id = :id RETURNING ${COLUMNS}`, { ...Object.fromEntries(keys.map((k) => [k, fields[k]])), actor: actor || null, id }, transaction);
  return row;
}

module.exports = { lockPerson, findByKey, findOne, findByOrigin, hasOpenCase, insert, update };
