'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

/**
 * Consultas de pessoas do bloco de governança (alertas do calendário, designações de dados): usuário ativo da empresa e usuários
 * ativos de um papel. A RLS isola a empresa; o filtro explícito por company_id vale de qualquer forma.
 */
const MEMBER_SQL = `FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
  WHERE m.company_id = :companyId AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`;

/** O usuário existe na empresa? { exists, active } (inexistente em outra empresa devolve exists=false). */
async function findCompanyUser(userId, tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT u.id, (m.status = 'ACTIVE' AND u.status = 'ACTIVE') AS active FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
      WHERE m.company_id = :companyId AND m.user_id = :userId AND m.deleted_at IS NULL AND u.deleted_at IS NULL LIMIT 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, userId } }
  );
  return rows[0] ? { exists: true, active: rows[0].active === true } : { exists: false, active: false };
}

/** Ids dos usuários ativos da empresa com o papel de nome `roleName` (sem diferenciar maiúsculas). */
async function activeUserIdsWithRole(roleName, tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT m.user_id ${MEMBER_SQL} AND m.role_id IN (SELECT id FROM core.roles WHERE upper(name) = upper(:roleName) AND deleted_at IS NULL)`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, roleName } }
  );
  return rows.map((row) => row.user_id);
}

/** Administradores ativos da empresa (papel ADMIN). */
function activeAdminIds(tenant, transaction) {
  return activeUserIdsWithRole('ADMIN', tenant, transaction);
}

module.exports = { findCompanyUser, activeUserIdsWithRole, activeAdminIds };
