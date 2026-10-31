'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/**
 * Diferenças bloqueantes em aberto da janela: para cada (entidade, chave, campo), o resultado da execução mais recente; só interessa se foi DIFF_BLOCKER. Uma execução seguinte
 * que devolve MATCH ou DIFF_ALLOWED para a mesma tupla a tira daqui (M9-D903 §3.6).
 */
const openBlockers = (tenant, windowId, transaction) => select(
  `SELECT * FROM (
     SELECT DISTINCT ON (entity, source_key, field) entity, source_key, field, result, diff_kind, run_number, old_value_hash, new_value_hash
       FROM governance.parallel_results WHERE company_id = :companyId AND window_id = :windowId ORDER BY entity, source_key, field, run_number DESC
   ) latest WHERE result = 'DIFF_BLOCKER' ORDER BY entity, source_key, field`,
  { companyId: tenant.companyId, windowId }, transaction
);

async function insertMany(tenant, window, run, rows, transaction) {
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const part = rows.slice(start, start + CHUNK);
    const values = part.map((_, i) => `(:groupId, :companyId, :windowId, :runId, :runNumber, :entity${i}, :key${i}, :field${i}, :old${i}, :new${i}, :result${i}, :kind${i})`).join(', ');
    const replacements = { groupId: tenant.groupId, companyId: tenant.companyId, windowId: window.id, runId: run.id, runNumber: run.run_number };
    part.forEach((row, i) => Object.assign(replacements, {
      [`entity${i}`]: row.entity, [`key${i}`]: row.sourceKey, [`field${i}`]: row.field || '', [`old${i}`]: row.oldHash || null, [`new${i}`]: row.newHash || null, [`result${i}`]: row.result, [`kind${i}`]: row.kind || null,
    }));
     
    await sequelize.query(`INSERT INTO governance.parallel_results (group_id, company_id, window_id, run_id, run_number, entity, source_key, field, old_value_hash, new_value_hash, result, diff_kind) VALUES ${values}`, { transaction, replacements });
  }
}

const countByResult = (tenant, runId, transaction) => select(
  'SELECT result, count(*)::int AS n FROM governance.parallel_results WHERE company_id = :companyId AND run_id = :runId GROUP BY result', { companyId: tenant.companyId, runId }, transaction
);

module.exports = { openBlockers, insertMany, countByResult };
