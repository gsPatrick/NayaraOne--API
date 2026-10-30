'use strict';

const logHold = require('./log.hold');

/**
 * Efeito de cada passo (M9-D863 §3.2). Quase todos são interruptores lidos por quem consome (a linha APPLIED em governance.degradation_actions é a flag):
 *  - SWITCH_AI_MODEL_CHEAPER: o roteador de IA troca o modelo das tarefas simples pela alternativa `cheaperAlternative` (ai/providers/router/degrade.js);
 *  - PAUSE_MARKETING_CAMPAIGNS: o agendamento de novas publicações e campanhas é recusado (marketing/degradation.guard.js);
 *  - LIMIT_EXPORT_SIZE: o max_rows efetivo cai para o percentual configurado (degradation/state.js, lido pelo DLP, pelo BI e pelo financeiro);
 *  - DEFER_NON_CRITICAL_JOBS: jobs de baixa prioridade só rodam na janela configurada (engines/jobs/calendarJobRunner.js);
 *  - REDUCE_LOG_LEVEL: este arquivo muda o nível do logger do processo (log.hold.js).
 * `capture` devolve o valor anterior (guardado para a reversão); `activate` e `deactivate` aplicam e desfazem o efeito do processo.
 */
const HANDLERS = Object.freeze({
  REDUCE_LOG_LEVEL: {
    capture: () => ({ logLevel: require('../../../../utils/logger').level }), // eslint-disable-line global-require
    activate: (tenant, params) => logHold.hold(tenant.companyId, params.logLevel),
    deactivate: (tenant) => logHold.release(tenant.companyId),
  },
});

const NOOP = { capture: () => ({ active: false }), activate: () => null, deactivate: () => null };

const handlerOf = (step) => HANDLERS[step] || NOOP;

module.exports = { handlerOf };
