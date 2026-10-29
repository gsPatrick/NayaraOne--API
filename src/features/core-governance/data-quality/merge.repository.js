'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { STATUS, KINDS } = require('./merge.constants');

const TABLE_OF = { PERSON: 'people.persons', SUPPLIER: 'people.persons', PROPERTY: 'real_estate.properties' };
const NAME_OF = { PERSON: 'legal_name', SUPPLIER: 'legal_name', PROPERTY: 'title' };
const ORDER = `(CASE WHEN a.status IN ('${STATUS.OPEN}', '${STATUS.IN_REVIEW}') THEN 0 ELSE 1 END), a.score DESC, a.created_at, a.id`;

/** Insere o par candidato; devolve a linha criada ou null se o par já está na fila (aberto ou decidido como separado/descartado). */
async function insertCandidate(tenant, item, transaction) {
  const [primaryId, secondaryId] = item.primaryId < item.secondaryId ? [item.primaryId, item.secondaryId] : [item.secondaryId, item.primaryId];
  const rows = await sequelize.query(
    `INSERT INTO governance.review_queue_items (group_id, company_id, entity_type, kind, primary_id, secondary_id, reason_code, score, status)
     VALUES (:groupId, :companyId, :entityType, :kind, :primaryId, :secondaryId, :reason, :score, :status) ON CONFLICT DO NOTHING RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { kind: KINDS.MERGE_CANDIDATE, status: STATUS.OPEN, groupId: tenant.groupId, companyId: tenant.companyId, entityType: item.entityType, primaryId, secondaryId, reason: item.reason, score: item.score } }
  );
  return rows[0] || null;
}

/** Cadastro com problema grave para o steward revisar (kind REVIEW, sem par); null se já há um REVIEW aberto para ele. */
async function insertReview(tenant, item, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.review_queue_items (group_id, company_id, entity_type, kind, primary_id, secondary_id, reason_code, score, status, evidence)
     VALUES (:groupId, :companyId, :entityType, :kind, :primaryId, NULL, :reason, :score, :status, CAST(:evidence AS jsonb)) ON CONFLICT DO NOTHING RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { kind: KINDS.REVIEW, status: STATUS.OPEN, groupId: tenant.groupId, companyId: tenant.companyId, entityType: item.entityType, primaryId: item.entityId, reason: item.reason, score: item.score, evidence: JSON.stringify(item.evidence || null) } }
  );
  return rows[0] || null;
}

async function lockItem(id, tenant, transaction) {
  const rows = await sequelize.query('SELECT * FROM governance.review_queue_items WHERE id = :id AND company_id = :companyId FOR UPDATE', {
    type: QueryTypes.SELECT, transaction, replacements: { id, companyId: tenant.companyId },
  });
  return rows[0] || null;
}

async function updateItem(id, fields, transaction) {
  const rows = await sequelize.query(
    `UPDATE governance.review_queue_items SET status = :status, assigned_steward_id = :stewardId, decided_by = :decidedBy, decided_at = now(), decision_note = :note,
            survivor_id = :survivorId, evidence = CAST(:evidence AS jsonb), updated_at = now() WHERE id = :id RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { id, status: fields.status, stewardId: fields.actorUserId, decidedBy: fields.actorUserId, note: fields.note || null, survivorId: fields.survivorId || null, evidence: JSON.stringify(fields.evidence || null) } }
  );
  return rows[0];
}

/** OPEN -> IN_REVIEW: a passagem fica gravada e o steward que decide é o responsável. */
async function markInReview(id, actorUserId, transaction) {
  await sequelize.query('UPDATE governance.review_queue_items SET status = :status, assigned_steward_id = :actorUserId, updated_at = now() WHERE id = :id', {
    transaction, replacements: { id, actorUserId, status: STATUS.IN_REVIEW },
  });
}

/** Trava os cadastros do par em ordem de id (sem deadlock entre decisões); devolve os que a empresa enxerga. */
async function lockRecords(entityType, ids, transaction) {
  return sequelize.query(`SELECT * FROM ${TABLE_OF[entityType]} WHERE id IN (:ids) ORDER BY id FOR UPDATE`, { type: QueryTypes.SELECT, transaction, replacements: { ids } });
}

async function listItems(tenant, filters, transaction) {
  const where = ['a.company_id = :companyId'];
  const replacements = { companyId: tenant.companyId, limit: filters.limit, offset: filters.offset };
  ['status', 'entityType', 'kind'].forEach((key) => {
    if (filters[key]) { where.push(`a.${key === 'entityType' ? 'entity_type' : key} = :${key}`); replacements[key] = filters[key]; }
  });
  const base = `FROM governance.review_queue_items a WHERE ${where.join(' AND ')}`;
  const [{ total }] = await sequelize.query(`SELECT count(*)::int AS total ${base}`, { type: QueryTypes.SELECT, transaction, replacements });
  const items = await sequelize.query(
    `SELECT a.*, CASE a.entity_type WHEN 'PROPERTY' THEN (SELECT title FROM real_estate.properties WHERE id = a.primary_id) ELSE (SELECT legal_name FROM people.persons WHERE id = a.primary_id) END AS primary_name,
            CASE a.entity_type WHEN 'PROPERTY' THEN (SELECT title FROM real_estate.properties WHERE id = a.secondary_id) ELSE (SELECT legal_name FROM people.persons WHERE id = a.secondary_id) END AS secondary_name
       ${base} ORDER BY ${ORDER} LIMIT :limit OFFSET :offset`,
    { type: QueryTypes.SELECT, transaction, replacements }
  );
  return { items, total };
}

module.exports = { TABLE_OF, NAME_OF, KINDS, STATUS, insertCandidate, insertReview, lockItem, updateItem, markInReview, lockRecords, listItems };
