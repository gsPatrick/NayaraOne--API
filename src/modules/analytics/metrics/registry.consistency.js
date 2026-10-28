'use strict';

/**
 * M9-D603 (3.3) — "registry consistente": toda versão vigente de métrica PUBLISHED aponta um formula_id que existe
 * no catálogo de fórmulas do código. Roda no CI (teste m9d603) e pode ser chamada no boot de ambientes de teste.
 */
const { sequelize } = require('../../../models');
const { getFormulaCatalog } = require('./formulaCatalog');

/** Devolve a lista de métricas publicadas cuja fórmula não existe no código (vazia = consistente). */
async function findInconsistentMetrics(transaction, catalog = getFormulaCatalog()) {
  const [rows] = await sequelize.query(
    `SELECT d.metric_code AS "metricCode", v.formula_id AS "formulaId"
       FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.status = 'PUBLISHED'`,
    { transaction }
  );
  return rows.filter((r) => !catalog.has(r.formulaId));
}

module.exports = { findInconsistentMetrics };
