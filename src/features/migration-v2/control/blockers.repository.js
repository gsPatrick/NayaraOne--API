'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const listOpen = (tenant, transaction) => select(
  `SELECT id, code, entity, ref, owner, detail, since FROM governance.mig_blockers WHERE company_id = :companyId AND closed_at IS NULL ORDER BY since, code, ref`, { companyId: tenant.companyId }, transaction
);

/** Abre o blocker; devolve a linha se foi esta chamada que o abriu (corrida: o índice único parcial deixa só uma). */
async function open(tenant, blocker, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_blockers (group_id, company_id, code, entity, ref, owner, detail) VALUES (:groupId, :companyId, :code, :entity, :ref, :owner, CAST(:detail AS jsonb))
     ON CONFLICT (company_id, code, COALESCE(entity, ''), ref) WHERE closed_at IS NULL DO NOTHING RETURNING id, since`,
    { groupId: tenant.groupId, companyId: tenant.companyId, code: blocker.code, entity: blocker.entity || null, ref: blocker.ref || '', owner: blocker.owner || null, detail: JSON.stringify(blocker.detail || {}) }, transaction
  );
  return row || null;
}

function update(tenant, id, blocker, transaction) {
  return sequelize.query('UPDATE governance.mig_blockers SET owner = :owner, detail = CAST(:detail AS jsonb), updated_at = now() WHERE company_id = :companyId AND id = :id AND closed_at IS NULL', {
    transaction, replacements: { companyId: tenant.companyId, id, owner: blocker.owner || null, detail: JSON.stringify(blocker.detail || {}) },
  });
}

/** Fecha o blocker; devolve a linha só se foi esta chamada que o fechou. */
async function close(tenant, id, transaction) {
  const [row] = await select('UPDATE governance.mig_blockers SET closed_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id AND closed_at IS NULL RETURNING id', { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** Lotes APPLIED (ainda não verificados) e HASH_MISMATCH por fonte, com os ids mais antigos (no máximo 20). */
function batchStates(tenant, transaction) {
  return select(
    `SELECT source_system, entity, status, count(*)::int AS count, (array_agg(id ORDER BY created_at))[1:20] AS batch_ids FROM governance.mig_batches
      WHERE company_id = :companyId AND status IN ('APPLIED', 'HASH_MISMATCH') GROUP BY source_system, entity, status ORDER BY 1, 2, 3`, { companyId: tenant.companyId }, transaction
  );
}

module.exports = { listOpen, open, update, close, batchStates };
