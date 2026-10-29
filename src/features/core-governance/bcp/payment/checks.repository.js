'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.manual_operation_checks (M9-D833). Uma linha por operação e papel; repetir não grava de novo. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Grava a checagem; devolve a linha criada ou null se o papel já estava gravado. */
async function insertCheck({ groupId, companyId, manualOperationId, role, userId, at }, transaction) {
  const rows = await select(
    `INSERT INTO governance.manual_operation_checks (group_id, company_id, manual_operation_id, role, user_id, at)
     VALUES (:groupId, :companyId, :manualOperationId, :role, :userId, COALESCE(CAST(:at AS timestamptz), now()))
     ON CONFLICT (manual_operation_id, role) DO NOTHING RETURNING id, role, user_id AS "userId", at`,
    { groupId, companyId, manualOperationId, role, userId, at: at || null }, transaction
  );
  return rows[0] || null;
}

const listChecks = (companyId, manualOperationId, transaction) => select(
  'SELECT id, role, user_id AS "userId", at FROM governance.manual_operation_checks WHERE company_id = :companyId AND manual_operation_id = :manualOperationId ORDER BY role',
  { companyId, manualOperationId }, transaction
);

/** O usuário tem a permissão por algum perfil ativo na empresa? */
async function userHasPermission(companyId, userId, code, transaction) {
  const rows = await select(
    `SELECT 1 AS ok FROM core.user_memberships m JOIN core.role_permissions rp ON rp.role_id = m.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.company_id = :companyId AND m.user_id = :userId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND p.code = :code LIMIT 1`,
    { companyId, userId, code }, transaction
  );
  return rows.length > 0;
}

module.exports = { insertCheck, listChecks, userHasPermission };
