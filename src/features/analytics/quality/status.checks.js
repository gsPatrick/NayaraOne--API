'use strict';

/**
 * M9-D697 (3.1) — qualidade vinda dos checks: a ÚLTIMA execução de cada check ao vivo (eventos e agenda; a execução sobre a sombra do rebuild não
 * conta) que afeta a métrica. Execução BLOCK que falhou, ou check em ERROR, deixa a métrica DEGRADED; a execução seguinte que passa supera a falha
 * (recuperação automática). A razão sai só com código e tipo do check, nunca com o valor observado (dado restrito).
 */
const { sequelize } = require('../../../models');
const { isBlocking } = require('./quality.severity');

async function lastRuns(metricCode, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (q.read_model, q.check_code) q.read_model AS "readModel", q.check_code AS "checkCode", q.check_type AS "checkType", q.status, q.severity
       FROM analytics.data_quality_checks q LEFT JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
      WHERE q.company_id = :companyId AND q.affected_metric_codes @> CAST(ARRAY[:metricCode] AS text[]) AND (r.id IS NULL OR r."trigger" <> 'REBUILD')
      ORDER BY q.read_model, q.check_code, q.executed_at DESC, q.created_at DESC`,
    { replacements: { companyId, metricCode }, transaction }
  );
  return rows;
}

const degrades = (r) => r.status === 'ERROR' || (r.status === 'FAILED' && isBlocking(r.severity));

/** { status: 'OK' | 'DEGRADED', degradedBy: [{ readModel, checkCode, checkType, status, severity }] }. */
async function checkQuality(metricCode, scope, transaction) {
  const bad = (await lastRuns(metricCode, scope.companyId, transaction)).filter(degrades);
  return { status: bad.length ? 'DEGRADED' : 'OK', degradedBy: bad };
}

module.exports = { checkQuality, degrades };
