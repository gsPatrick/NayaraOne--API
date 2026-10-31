'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { STATUS, COMPANY, WILDCARD } = require('./legalHold.constants');
const { TABLES, qualified } = require('./legalHold.catalog');

const q = (sql, replacements, transaction, type = QueryTypes.SELECT) => sequelize.query(sql, { type, transaction, replacements });

const fromRow = (row) => (row ? {
  id: row.id, groupId: row.group_id, companyId: row.company_id, code: row.code, reason: row.reason, matterRef: row.matter_ref, scope: row.scope, status: row.status,
  createdBy: row.created_by, createdAt: row.created_at, releasedBy: row.released_by, releasedAt: row.released_at, releaseReason: row.release_reason,
} : null);

/** Trava de disposição: a criação de retenção leva a trava exclusiva e cada disposição, a compartilhada, na mesma transação (uma enxerga a outra, sem corrida). */
const lockKey = (companyId) => `governance.legal_hold:${companyId || ''}`;
const lockDisposal = (companyId, transaction) => q('SELECT pg_advisory_xact_lock_shared(hashtextextended(:key, 0))', { key: lockKey(companyId) }, transaction);
const lockCreation = (companyId, transaction) => q('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { key: lockKey(companyId) }, transaction);

const contextCompany = async (transaction) => (await q("SELECT NULLIF(current_setting('app.company_id', true), '') AS id", {}, transaction))[0].id;
const contextUser = async (transaction) => (await q("SELECT NULLIF(current_setting('app.user_id', true), '') AS id", {}, transaction))[0].id;

/** As retenções ATIVAS visíveis na transação (RLS) e, se a empresa é conhecida, só as dela. */
async function activeHolds(companyId, transaction) {
  const rows = await q(`SELECT * FROM governance.legal_holds WHERE status = :active ${companyId ? 'AND company_id = :companyId' : ''}`, { active: STATUS.ACTIVE, companyId }, transaction);
  return rows.map(fromRow);
}

/**
 * Dos `ids` do `type`, as linhas de alvo que valem agora (retenção ativa). Devolve { all, ids }: `all` quando a empresa inteira ou o tipo todo está protegido. FOR SHARE: quem
 * apaga segura a linha enquanto a transação dura (a liberação e o recálculo esperam).
 */
async function heldAmong(companyId, type, ids, transaction, { lock }) {
  const rows = await q(
    `SELECT t.entity_type, t.entity_id FROM governance.legal_hold_targets t JOIN governance.legal_holds h ON h.id = t.hold_id AND h.status = :active
      WHERE ${companyId ? 't.company_id = :companyId AND' : ''} (t.entity_type = :company OR (t.entity_type = :type AND (t.entity_id = :wildcard OR t.entity_id IN (:ids))))
      ${lock ? 'FOR SHARE OF t' : ''}`,
    { active: STATUS.ACTIVE, companyId, company: COMPANY, type, wildcard: WILDCARD, ids }, transaction
  );
  const all = rows.some((row) => row.entity_type === COMPANY || row.entity_id === WILDCARD);
  return { all, ids: new Set(rows.map((row) => row.entity_id)) };
}

/** Processos com a marca antiga `legal_hold` (M5-26): também valem como retenção legal. */
async function markedCases(ids, transaction) {
  const rows = await q('SELECT id::text AS id FROM legal.legal_cases WHERE legal_hold IS TRUE AND id::text IN (:ids)', { ids }, transaction);
  return rows.map((row) => row.id);
}

async function insertHold(hold, transaction) {
  const rows = await q(
    `INSERT INTO governance.legal_holds (group_id, company_id, code, reason, matter_ref, scope, created_by) VALUES (:groupId, :companyId, :code, :reason, :matterRef, CAST(:scope AS jsonb), :createdBy) RETURNING *`,
    { ...hold, scope: JSON.stringify(hold.scope) }, transaction
  );
  return fromRow(rows[0]);
}

const codeTaken = async (companyId, code, transaction) => (await q('SELECT 1 AS x FROM governance.legal_holds WHERE company_id = :companyId AND code = :code', { companyId, code }, transaction)).length > 0;
const findById = async (tenant, id, transaction, { forUpdate = false } = {}) => fromRow((await q(`SELECT * FROM governance.legal_holds WHERE id = :id AND company_id = :companyId ${forUpdate ? 'FOR UPDATE' : ''}`, { id, companyId: tenant.companyId }, transaction))[0]);

async function release(id, userId, reason, transaction) {
  const rows = await q(
    "UPDATE governance.legal_holds SET status = 'RELEASED', released_by = :userId, released_at = now(), release_reason = :reason WHERE id = :id AND status = 'ACTIVE' RETURNING *",
    { id, userId, reason }, transaction
  );
  return fromRow(rows[0]);
}

async function list(tenant, filters, page, transaction) {
  const where = ['h.company_id = :companyId']; const replacements = { companyId: tenant.companyId, limit: page.pageSize, offset: (page.page - 1) * page.pageSize };
  if (filters.status) { where.push('h.status = :status'); replacements.status = filters.status; }
  if (filters.code) { where.push('h.code ILIKE :code'); replacements.code = `%${filters.code.replace(/[%_]/g, '')}%`; }
  const rows = await q(
    `SELECT h.*, (SELECT count(*)::int FROM governance.legal_hold_targets t WHERE t.hold_id = h.id) AS target_count FROM governance.legal_holds h WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC, h.id LIMIT :limit OFFSET :offset`,
    replacements, transaction
  );
  const total = (await q(`SELECT count(*)::int AS n FROM governance.legal_holds h WHERE ${where.join(' AND ')}`, replacements, transaction))[0].n;
  return { rows: rows.map((row) => ({ ...fromRow(row), targetCount: row.target_count })), total };
}

const countTargets = async (id, transaction) => (await q('SELECT entity_type, count(*)::int AS n FROM governance.legal_hold_targets WHERE hold_id = :id GROUP BY entity_type ORDER BY entity_type', { id }, transaction)).map((row) => ({ entityType: row.entity_type, count: row.n }));

/** O registro existe (e é visível pela RLS) na empresa? INTEGRATION é a própria empresa. */
async function recordExists(type, id, companyId, transaction) {
  if (!TABLES[type]) return id === companyId;
  const rows = await q(`SELECT 1 AS x FROM ${qualified(type)} WHERE id::text = :id AND company_id = :companyId`, { id, companyId }, transaction);
  return rows.length > 0;
}

module.exports = { fromRow, lockDisposal, lockCreation, contextCompany, contextUser, activeHolds, heldAmong, markedCases, insertHold, codeTaken, findById, release, list, countTargets, recordExists };
