'use strict';

const repo = require('./degradation.repository');
const { readDegradationParams } = require('./degradation.params');

/**
 * Leitura do estado de degradação por quem consome os efeitos (M9-D863). A "flag" de cada passo é a linha APPLIED em governance.degradation_actions da
 * empresa: sem linha, comportamento normal. Leituras baratas (uma consulta indexada) e sempre dentro da transação do tenant do chamador.
 */
const isStepActive = (step, tenant, transaction) => repo.isStepApplied(tenant, step, transaction);

/** LIMIT_EXPORT_SIZE: o max_rows efetivo. Passo ativo => `degradacao.exportacao_percentual` do valor base (mínimo 1); senão o próprio valor. Nulo continua nulo. */
async function effectiveMaxRows(base, tenant, transaction) {
  if (base === null || base === undefined || !(Number(base) > 0)) return base;
  if (!(await isStepActive('LIMIT_EXPORT_SIZE', tenant, transaction))) return base;
  const { exportPercent } = await readDegradationParams(tenant, transaction);
  return Math.max(1, Math.floor((Number(base) * exportPercent) / 100));
}

const hourInSaoPaulo = (date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(date));

/** DEFER_NON_CRITICAL_JOBS: este job de baixa prioridade deve esperar agora? Só com o passo ativo, só para os jobs listados e só fora da janela configurada. */
async function shouldDeferJob(jobName, tenant, transaction, now = new Date()) {
  if (!(await isStepActive('DEFER_NON_CRITICAL_JOBS', tenant, transaction))) return false;
  const params = await readDegradationParams(tenant, transaction);
  if (!params.lowPriorityJobs.some((name) => jobName === name || jobName.startsWith(`${name}.`))) return false;
  const hour = hourInSaoPaulo(now);
  return !(hour >= params.windowStart && hour < params.windowEnd);
}

module.exports = { isStepActive, effectiveMaxRows, shouldDeferJob, hourInSaoPaulo };
