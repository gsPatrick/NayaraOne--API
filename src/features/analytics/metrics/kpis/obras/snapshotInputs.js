'use strict';

/**
 * M9-D650 / M9-D651 — peças comuns de montagem do snapshot de um KPI de Obras: a versão publicada vigente da empresa e a lista de entradas de
 * snapshot (valor principal com dimensão vazia, mais uma por dimensão que a fórmula devolve).
 */
const { sequelize } = require('../../../../../models');

async function publishedVersion(code, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.id AS "metricId", v.id AS "metricVersionId", v.version, v.unit FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = :companyId AND d.status = 'PUBLISHED'`, { replacements: { code, companyId }, transaction });
  return rows[0];
}

const snapshotInputs = (base, result) => [
  { ...base, dimensionKey: '', valueNumeric: result.value },
  ...(result.dimensions || []).map((d) => ({ ...base, dimensionKey: d.key, valueNumeric: d.value })),
];

module.exports = { publishedVersion, snapshotInputs };
