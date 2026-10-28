'use strict';

/**
 * M9-D602 — resultado de cada verificação de qualidade (analytics.data_quality_checks): uma linha por execução.
 * Os checks em si (frescor, reconciliação, duplicidade...) são da M9-D696; aqui só o registro. Escrita do worker.
 */

const { sequelize } = require('../../models');
const { invalid, requireOneOf, isPlainObject, assertWriter } = require('./analyticsStoreSupport');
const { runAlert } = require('./alertErrors');
const { SEVERITIES } = require('./alertDefinitionRules');

const CODE = 'ANALYTICS_QUALITY_CHECK_INVALID';
const CHECK_TYPES = ['COMPLETENESS', 'DUPLICATION', 'FRESHNESS', 'RECONCILIATION', 'CONSISTENCY', 'ROW_COUNT_RANGE', 'INVARIANT'];
const STATUSES = ['PASSED', 'FAILED', 'ERROR'];
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const METRIC_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;

function validate(input) {
  if (typeof input.checkCode !== 'string' || !NAME_RE.test(input.checkCode)) throw invalid(CODE, 'O código do check deve usar minúsculas, números e "_".');
  if (typeof input.readModel !== 'string' || !NAME_RE.test(input.readModel)) throw invalid(CODE, 'O read model deve usar minúsculas, números e "_".');
  requireOneOf(input.checkType, CHECK_TYPES, 'Tipo de check', CODE);
  requireOneOf(input.status, STATUSES, 'Resultado do check', CODE);
  requireOneOf(input.severity, SEVERITIES, 'Severidade', CODE);
  if (!input.groupId) throw invalid(CODE, 'Informe o grupo.');
  for (const key of ['expected', 'observed']) {
    if (input[key] !== undefined && !isPlainObject(input[key])) throw invalid(CODE, `${key} deve ser um objeto.`);
  }
  const metrics = input.affectedMetricCodes;
  if (metrics !== undefined && !(Array.isArray(metrics) && metrics.every((m) => typeof m === 'string' && METRIC_RE.test(m)))) {
    throw invalid(CODE, 'As métricas afetadas devem ser códigos no formato dominio.nome_em_snake.');
  }
}

/** Grava o resultado de uma execução de check, ligado ao refresh que o motivou (quando houver). */
async function recordQualityCheck(input, ctx, transaction) {
  await assertWriter(transaction);
  validate(input);
  return runAlert(async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.data_quality_checks
         (company_id, group_id, check_code, read_model, check_type, status, expected, observed, severity, affected_metric_codes, executed_at, refresh_id)
       VALUES (:companyId, :groupId, :checkCode, :readModel, :checkType, :status, CAST(:expected AS jsonb), CAST(:observed AS jsonb), :severity,
          CAST(:metrics AS text[]), COALESCE(:executedAt, now()), :refreshId)
       RETURNING *`,
      {
        replacements: {
          companyId: input.companyId || null, groupId: input.groupId, checkCode: input.checkCode, readModel: input.readModel,
          checkType: input.checkType, status: input.status, expected: JSON.stringify(input.expected || {}),
          observed: JSON.stringify(input.observed || {}), severity: input.severity,
          metrics: `{${(input.affectedMetricCodes || []).map((m) => `"${m}"`).join(',')}}`,
          executedAt: input.executedAt || null, refreshId: input.refreshId || null,
        },
        transaction,
      }
    );
    return row;
  });
}

/** Checks gravados para um refresh, na ordem de execução. */
async function listChecksForRefresh(refreshId, transaction) {
  const [rows] = await sequelize.query('SELECT * FROM analytics.data_quality_checks WHERE refresh_id = :refreshId ORDER BY executed_at, created_at', {
    replacements: { refreshId }, transaction,
  });
  return rows;
}

module.exports = { recordQualityCheck, listChecksForRefresh };
