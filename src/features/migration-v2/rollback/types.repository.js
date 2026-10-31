'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `id, code, module, reversibility, compensation, procedure, owner, entity, operations, updated_at AS "updatedAt"`;

const list = (tenant, transaction) => select(`SELECT ${COLUMNS} FROM governance.external_op_types WHERE company_id = :companyId ORDER BY code`, { companyId: tenant.companyId }, transaction);
const findByOperation = async (tenant, operation, transaction) => (await select(
  `SELECT ${COLUMNS} FROM governance.external_op_types WHERE company_id = :companyId AND :operation = ANY(operations) ORDER BY code LIMIT 1`, { companyId: tenant.companyId, operation }, transaction
))[0] || null;
const findByCode = async (tenant, code, transaction) => (await select(
  `SELECT ${COLUMNS} FROM governance.external_op_types WHERE company_id = :companyId AND code = :code FOR UPDATE`, { companyId: tenant.companyId, code }, transaction
))[0] || null;

/** Grava (ou troca) um tipo. `operations` é lista de nomes; devolve a linha gravada. */
async function upsert(tenant, t, transaction) {
  const [row] = await select(
    `INSERT INTO governance.external_op_types (group_id, company_id, code, module, reversibility, compensation, procedure, owner, entity, operations)
     VALUES (:groupId, :companyId, :code, :module, :reversibility, :compensation, :procedure, :owner, :entity, CAST(:operations AS text[]))
     ON CONFLICT (company_id, code) DO UPDATE SET module = EXCLUDED.module, reversibility = EXCLUDED.reversibility, compensation = EXCLUDED.compensation, procedure = EXCLUDED.procedure,
       owner = EXCLUDED.owner, entity = EXCLUDED.entity, operations = EXCLUDED.operations, updated_at = now()
     RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, ...t, entity: t.entity || null, operations: `{${t.operations.join(',')}}` }, transaction
  );
  return row;
}

/** Tipo criado por uma operação perigosa que nenhum tipo cobre: IRREVERSIBLE e sem plano (a Torre abre o blocker até o plano ser cadastrado). */
async function createUnmapped(tenant, { code, module, operation }, transaction) {
  await sequelize.query(
    `INSERT INTO governance.external_op_types (group_id, company_id, code, module, reversibility, operations)
     VALUES (:groupId, :companyId, :code, :module, 'IRREVERSIBLE', CAST(:operations AS text[])) ON CONFLICT (company_id, code) DO NOTHING`,
    { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, code, module, operations: `{${operation}}` } }
  );
  return (await select(`SELECT ${COLUMNS} FROM governance.external_op_types WHERE company_id = :companyId AND code = :code`, { companyId: tenant.companyId, code }, transaction))[0];
}

module.exports = { list, findByOperation, findByCode, upsert, createUnmapped };
