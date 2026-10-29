'use strict';

/**
 * M9-D696 (3.4) — estado de qualidade do dataset (read model) da empresa, derivado da ÚLTIMA execução de cada check do refresh ao vivo
 * (eventos e agenda; as execuções sobre a sombra do rebuild não contam). DEGRADED se alguma última execução é BLOCK que falhou ou ERROR;
 * a execução seguinte que passa supera a falha anterior. A tela e o Centro de Comando leem isto (M9-D697).
 */
const { sequelize } = require('../../../models');

async function datasetQuality(readModel, scope, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (q.check_code) q.check_code, q.status, q.severity, q.affected_metric_codes
       FROM analytics.data_quality_checks q LEFT JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
      WHERE q.company_id = :companyId AND q.read_model = :readModel AND (r.id IS NULL OR r."trigger" <> 'REBUILD')
      ORDER BY q.check_code, q.executed_at DESC, q.created_at DESC`,
    { replacements: { companyId: scope.companyId, readModel }, transaction }
  );
  const bad = rows.filter((r) => r.status === 'ERROR' || (r.status === 'FAILED' && r.severity === 'CRITICAL'));
  const warnings = rows.filter((r) => r.status === 'FAILED' && r.severity !== 'CRITICAL').map((r) => r.check_code);
  return {
    readModel, status: bad.length ? 'DEGRADED' : 'OK', degradedBy: bad.map((r) => r.check_code), warnings,
    affectedMetricCodes: [...new Set(bad.flatMap((r) => r.affected_metric_codes || []))].sort(),
  };
}

module.exports = { datasetQuality };
