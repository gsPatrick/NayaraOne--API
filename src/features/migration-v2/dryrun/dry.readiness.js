'use strict';

const readiness = require('../rollback/readiness');
const repo = require('./dry.repository');

const GAP = 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED';

/**
 * Pré-requisito do GO (M9-D907 §3.4, recebido na M9-D908): a simulação de rollback tem de ter sido executada no DRY3. Vale o ensaio concluído mais recente da empresa: o critério
 * `rollback_simulated` dele tem de estar verde. Sem ensaio, ou com a simulação incompleta, o GO devolve 409 GOV_CUTOVER_NOT_READY com a lacuna { code, detail }.
 */
async function rollbackSimulated(tenant, transaction) {
  const last = await repo.latestCompleted(tenant, transaction);
  const criterion = last && last.criteria && last.criteria.rollback_simulated;
  if (criterion && criterion.ok === true) return [];
  return [{ code: GAP, detail: { dryRunId: last ? last.id : null, reason: last ? 'A simulação de rollback do último ensaio DRY3 não foi concluída.' : 'Nenhum ensaio DRY3 foi concluído.' } }];
}

readiness.register('dry3-rollback-simulation', rollbackSimulated);

module.exports = { rollbackSimulated, GAP };
