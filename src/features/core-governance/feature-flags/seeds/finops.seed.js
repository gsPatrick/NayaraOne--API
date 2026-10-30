'use strict';

/**
 * Flags declaradas pelo FinOps (M9-D863/M9-D870) para o relatório de CI (M9-D871): os cinco interruptores de degradação por custo. São permanentes (sem expiração); o valor
 * vivo mora no banco de cada empresa, ajustado pelo finopsDegradationJob. Declarar aqui só dá ao CI a visão do que está versionado.
 */
const { STEPS } = require('../../finops/degradation/degradation.constants');

const DESCRIPTION = {
  SWITCH_AI_MODEL_CHEAPER: 'usar o modelo de IA mais barato',
  PAUSE_MARKETING_CAMPAIGNS: 'pausar novos agendamentos de Marketing',
  REDUCE_LOG_LEVEL: 'reduzir o nível de log',
  LIMIT_EXPORT_SIZE: 'limitar o tamanho das exportações',
  DEFER_NON_CRITICAL_JOBS: 'adiar jobs de baixa prioridade',
};

module.exports = {
  domain: 'finops',
  flags: STEPS.map((step) => ({ key: `finops.degradation.${step.toLowerCase()}`, owner: 'Financeiro', risk: 'MEDIUM', description: `Degradação por custo: ${DESCRIPTION[step]}.` })),
};
