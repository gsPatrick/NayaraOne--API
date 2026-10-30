'use strict';

/**
 * M9-D608 (3.2 passo 3) — checks de qualidade sobre a tabela SOMBRA, antes da troca. Os checks em si são da M9-D696: ela registra aqui o
 * seu executor com `onRebuildChecks(fn)`. `fn({ readModel, companyId, groupId, shadowTable, refreshId, transaction })` devolve uma lista de
 * { checkCode, checkType, status, severity, expected, observed, affectedMetricCodes }. Cada resultado é gravado em data_quality_checks
 * ligado ao refresh do rebuild. FAILED ou ERROR com severidade CRITICAL (a "alta" do livro; BLOCK na D696) aborta a reconstrução.
 * Check que lança erro vira ERROR CRITICAL (o dataset é tratado como degradado por precaução, D696 3.5).
 */
const { recordQualityCheck } = require('../dataQualityCheckStore.service');
const { shadowName } = require('./rebuild.shadow');

const executors = [];

function onRebuildChecks(fn) {
  executors.push(fn);
  return () => { const i = executors.indexOf(fn); if (i >= 0) executors.splice(i, 1); };
}

const isBlocking = (c) => (c.status === 'FAILED' || c.status === 'ERROR') && c.severity === 'CRITICAL';

/** Roda os executores sobre a sombra e grava o resultado. Devolve { checks, blocked }. */
async function runRebuildChecks({ def, scope, refreshId }, transaction) {
  const results = [];
  for (const fn of executors) {
    try {
      results.push(...(await fn({ readModel: def.name, ...scope, shadowTable: shadowName(def.name, scope.companyId), refreshId, transaction })) || []);
    } catch (err) {
      results.push({ checkCode: 'rebuild_check_execution', checkType: 'CONSISTENCY', status: 'ERROR', severity: 'CRITICAL', expected: {}, observed: { error: String(err.message || err).slice(0, 500) } });
    }
  }
  const saved = [];
  for (const check of results) {
    saved.push(await recordQualityCheck({ ...check, readModel: def.name, companyId: scope.companyId, groupId: scope.groupId, refreshId }, scope, transaction));
  }
  return { checks: saved, blocked: saved.some(isBlocking) };
}

module.exports = { onRebuildChecks, runRebuildChecks };
