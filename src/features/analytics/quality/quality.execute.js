'use strict';

/**
 * M9-D696 (3.2, 3.5) — executa os checks declarados de um read model e devolve o resultado de cada um, SEM gravar. Cada check roda no seu
 * próprio savepoint: um erro de consulta não aborta a transação nem os outros checks, e vira status ERROR (o dataset é tratado como DEGRADED
 * por precaução, 3.5). Severidade do livro (WARN, BLOCK) vem do parâmetro `analytics.qualidade.severidades` e é gravada como WARNING/CRITICAL.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const clock = require('../metrics/clock');
const { getChecks } = require('./quality.catalog');
const { readQualityParams } = require('./quality.settings');
const { storedSeverity } = require('./quality.severity');

const ERROR_CODE = 'ANALYTICS_QUALITY_CHECK_ERROR';
const ERROR_MESSAGE = 'Não foi possível verificar a qualidade; o indicador foi marcado como degradado.';

// Severidade do check que não pôde rodar: a do tipo dele (sem ela, o erro de um check BLOCK passaria como aviso).
const TYPE_SEVERITY_KEY = Object.freeze({ FRESHNESS: 'FRESHNESS_EXPIRED', COMPLETENESS: 'COMPLETENESS' });

function result(check, status, severity, expected, observed) {
  return { checkCode: check.code, checkType: check.type, status, severity, expected, observed, affectedMetricCodes: check.metrics || [] };
}

async function runOne(check, ctx) {
  try {
    const out = await sequelize.transaction({ transaction: ctx.transaction }, (savepoint) => check.run({ ...ctx, transaction: savepoint }));
    if (out.passed) return result(check, 'PASSED', 'INFO', out.expected, out.observed);
    return result(check, 'FAILED', storedSeverity(ctx.params.severities[out.severityKey]), out.expected, out.observed);
  } catch (err) {
    logger.error({ event: 'analytics.quality.check_error', readModel: ctx.readModel, checkCode: check.code, companyId: ctx.scope.companyId, err }, '[analytics] o check de qualidade não pôde rodar');
    const level = ctx.params.severities[TYPE_SEVERITY_KEY[check.type] || check.type];
    return result(check, 'ERROR', storedSeverity(level), {}, { code: ERROR_CODE, message: ERROR_MESSAGE, error: String((err && err.message) || err).slice(0, 500), table: ctx.table });
  }
}

/**
 * input: { readModel, scope: { companyId, groupId }, table?, refreshId?, rowsUpserted?, mode: 'EVENT' | 'SCHEDULE' | 'REBUILD' }.
 * `table` é a tabela lida (a sombra no rebuild); padrão: o próprio read model.
 */
async function executeChecks(input, transaction) {
  const checks = getChecks(input.readModel);
  if (!checks.length) return [];
  const params = await readQualityParams(input.scope, transaction);
  const ctx = {
    readModel: input.readModel, table: input.table || input.readModel, scope: input.scope, refreshId: input.refreshId || null,
    rowsUpserted: input.rowsUpserted ?? 0, mode: input.mode || 'EVENT', params, now: clock.now(), transaction,
  };
  const out = [];
  for (const check of checks) out.push(await runOne(check, ctx));
  return out;
}

module.exports = { executeChecks, ERROR_CODE, ERROR_MESSAGE };
