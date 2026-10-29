'use strict';

/**
 * M9-D692 (3.2) — quem pode ser destinatário do alerta: usuários ATIVOS (usuário e vínculo) da empresa, por id ou por papel (nome do papel sem
 * diferenciar maiúsculas). Leitura direta de core.user_memberships/core.users/core.roles (o BI não importa serviço de outro módulo, M9-D612).
 * A RLS isola a empresa; o filtro explícito vale de qualquer forma. Ordem estável por id (a tarefa vai ao primeiro).
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const ACTIVE_SQL = `FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
  WHERE m.company_id = :companyId AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`;

async function isActiveUser(userId, companyId, transaction) {
  const rows = await sequelize.query(`SELECT 1 ${ACTIVE_SQL} AND m.user_id = :userId LIMIT 1`, { type: QueryTypes.SELECT, transaction, replacements: { companyId, userId } });
  return rows.length > 0;
}

async function activeUsersOfRole(roleName, companyId, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT m.user_id ${ACTIVE_SQL} AND m.role_id IN (SELECT id FROM core.roles WHERE upper(name) = upper(:roleName) AND deleted_at IS NULL) ORDER BY m.user_id`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId, roleName: String(roleName).trim() } }
  );
  return rows.map((row) => row.user_id);
}

module.exports = { isActiveUser, activeUsersOfRole };
