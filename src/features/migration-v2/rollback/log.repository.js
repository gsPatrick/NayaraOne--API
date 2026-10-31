'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Grava a operação no registro (uma por envio: o mesmo `dispatch_id` não entra duas vezes). Devolve o id ou null se já estava. */
async function insert(tenant, row, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.external_op_log (group_id, company_id, type_id, op_type, reference, executed_at, entity, amount_cents, dispatch_id)
     VALUES (:groupId, :companyId, :typeId, :opType, :reference, COALESCE(CAST(:executedAt AS timestamptz), now()), :entity, :amountCents, :dispatchId)
     ON CONFLICT (company_id, dispatch_id) WHERE dispatch_id IS NOT NULL DO NOTHING RETURNING id`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, executedAt: null, amountCents: null, dispatchId: null, ...row } }
  );
  return rows.length ? rows[0].id : null;
}

module.exports = { insert };
