'use strict';

/**
 * M9-D614 (regra 4) — leitura das versões publicadas com o hash do código da fórmula gravado na publicação, para o guarda comparar
 * com o arquivo atual (`scripts/analytics/guardrails/rule4.formulaCodeHash.js`). Só leitura; a RLS do tenant corrente vale.
 */
const { sequelize } = require('../../../models');

async function listPublishedVersionHashes(transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.metric_code AS "metricCode", v.version, v.formula_id AS "formulaId", v.formula_code_hash AS "formulaCodeHash"
       FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id
      WHERE d.status = 'PUBLISHED' ORDER BY d.metric_code, v.version`,
    { transaction }
  );
  return rows;
}

module.exports = { listPublishedVersionHashes };
