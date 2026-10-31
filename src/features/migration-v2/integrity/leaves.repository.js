'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const CHUNK = 500;

/** Grava as folhas do lote (as anteriores saem: aplicar de novo o mesmo lote refaz a árvore). `leaves`: [{ key, hash (hex) }]. */
async function replaceLeaves(tenant, batchId, leaves, transaction) {
  await sequelize.query('DELETE FROM governance.mig_batch_leaves WHERE company_id = :companyId AND batch_id = :batchId', { transaction, replacements: { companyId: tenant.companyId, batchId } });
  for (let i = 0; i < leaves.length; i += CHUNK) {
    const part = leaves.slice(i, i + CHUNK);
    const replacements = { groupId: tenant.groupId, companyId: tenant.companyId, batchId };
    const values = part.map((leaf, index) => { replacements[`k${index}`] = leaf.key; replacements[`h${index}`] = leaf.hash; return `(:groupId, :companyId, :batchId, :k${index}, :h${index})`; });
     
    await sequelize.query(`INSERT INTO governance.mig_batch_leaves (group_id, company_id, batch_id, source_key, leaf_hash_source) VALUES ${values.join(', ')}`, { transaction, replacements });
  }
}

const listLeaves = (tenant, batchId, transaction) => sequelize.query(
  'SELECT source_key, leaf_hash_source, leaf_hash_target FROM governance.mig_batch_leaves WHERE company_id = :companyId AND batch_id = :batchId ORDER BY source_key',
  { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, batchId } }
);

/** Grava o lado do destino de cada folha (nulo = a linha não foi encontrada no destino). `targets`: Map chave -> hash hex ou null. */
async function setTargetHashes(tenant, batchId, targets, transaction) {
  const entries = [...targets.entries()];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    const replacements = { companyId: tenant.companyId, batchId };
    const values = part.map(([key, hash], index) => { replacements[`k${index}`] = key; replacements[`h${index}`] = hash; return `(:k${index}, CAST(:h${index} AS text))`; });
     
    await sequelize.query(
      `UPDATE governance.mig_batch_leaves l SET leaf_hash_target = v.h FROM (VALUES ${values.join(', ')}) AS v(k, h) WHERE l.company_id = :companyId AND l.batch_id = :batchId AND l.source_key = v.k`,
      { transaction, replacements }
    );
  }
}

module.exports = { replaceLeaves, listLeaves, setTargetHashes };
