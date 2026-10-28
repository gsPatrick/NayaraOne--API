'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.calendar_commitments (origem dos compromissos avulsos). A RLS isola a empresa. */
function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    ownerUserId: row.owner_user_id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function findById(id, tenant, transaction, { forUpdate = false } = {}) {
  const rows = await sequelize.query(
    `SELECT * FROM governance.calendar_commitments WHERE id = :id AND company_id = :companyId ${forUpdate ? 'FOR UPDATE' : ''}`,
    { type: QueryTypes.SELECT, transaction, replacements: { id, companyId: tenant.companyId } }
  );
  return present(rows[0]);
}

async function insert(tenant, data, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.calendar_commitments (group_id, company_id, title, starts_at, ends_at, owner_user_id, status)
     VALUES (:groupId, :companyId, :title, :startsAt, :endsAt, :ownerUserId, 'OPEN') RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, ...data } }
  );
  return present(rows[0]);
}

async function update(id, tenant, data, transaction) {
  const rows = await sequelize.query(
    `UPDATE governance.calendar_commitments
        SET title = :title, starts_at = :startsAt, ends_at = :endsAt, owner_user_id = :ownerUserId, status = :status, updated_at = now()
      WHERE id = :id AND company_id = :companyId RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { id, companyId: tenant.companyId, ...data } }
  );
  return present(rows[0]);
}

/** A pessoa responsável precisa ser membro da empresa. */
async function isCompanyMember(userId, tenant, transaction) {
  const rows = await sequelize.query(
    'SELECT 1 FROM core.user_memberships WHERE user_id = :userId AND company_id = :companyId AND deleted_at IS NULL LIMIT 1',
    { type: QueryTypes.SELECT, transaction, replacements: { userId, companyId: tenant.companyId } }
  );
  return rows.length > 0;
}

module.exports = { findById, insert, update, isCompanyMember };
