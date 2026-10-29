'use strict';

/**
 * M9-D625 — leitura do read model rm_finance_intercompany para quem fica FORA da camada read-models (o consolidado do grupo): as transferências
 * aprovadas da empresa de origem sob o contexto de RLS que o chamador já preparou na transação. Só leitura.
 */
const { sequelize } = require('../../../models');
const { P, assertPermission } = require('../security');

/** Exige `analytics:read:group` (o consolidado do grupo é o único leitor). Linhas da empresa `companyId` (origem): [{ transfer_id, origin_company_id, to_company_id, amount, pair_state, lados... }]. */
async function readIntercompanyPairs(ctx, companyId, transaction) {
  assertPermission(ctx, P.READ_GROUP);
  const groupId = ctx.groupId;
  const [rows] = await sequelize.query(
    `SELECT transfer_id::text, company_id::text AS origin_company_id, to_company_id::text, amount::text, pair_state, from_entry_status, from_amount::text,
            from_due_at, from_settled_at, to_entry_status, to_amount::text, to_due_at, to_settled_at
       FROM analytics.rm_finance_intercompany WHERE company_id = :companyId AND group_id = :groupId ORDER BY transfer_id`,
    { replacements: { companyId, groupId }, transaction }
  );
  return rows;
}

module.exports = { readIntercompanyPairs };
