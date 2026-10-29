'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parseRoles } = require('../health/alerts/alerts.limits');
const { MODES_WITHOUT_QUEUE } = require('./contingency.constants');
const { PADROES, LIMITES, inRange } = require('./contingency.limits');

const inteiro = (v, padrao, lim) => (inRange(v, lim) ? v : padrao);

/** Prazo padrão da fila (horas) do modo: o parâmetro do modo; o banco lê a régua única do banco; sem fila (IA) devolve null. */
async function modeQueueMaxAgeH(mode, ctx, transaction) {
  if (MODES_WITHOUT_QUEUE.includes(mode)) return null;
  if (mode === 'NO_ASSUME_AND_QUERY') return inteiro(await getSetting('integration.bank.max_pending_hours', ctx, transaction, PADROES.bankMaxPendingH), PADROES.bankMaxPendingH, LIMITES.bankMaxPendingH);
  return inteiro(await getSetting(`integration.contingency.queue_max_age_h.${mode}`, ctx, transaction, PADROES.queueMaxAgeH), PADROES.queueMaxAgeH, LIMITES.queueMaxAgeH);
}

async function readContingencyParams(ctx, transaction) {
  const [checks, assignee, notify, due, drain, batch] = await Promise.all([
    getSetting('integration.contingency.recovery_checks', ctx, transaction, PADROES.recoveryChecks),
    getSetting('integration.contingency.manual_task_assignee_role', ctx, transaction, PADROES.manualTaskAssigneeRole),
    getSetting('integration.contingency.notify_roles', ctx, transaction, PADROES.notifyRoles),
    getSetting('integration.contingency.manual_task_due_h', ctx, transaction, PADROES.manualTaskDueH),
    getSetting('integration.contingency.drain_batch_size', ctx, transaction, PADROES.drainBatchSize),
    getSetting('integration.contingency.manual_task_batch_size', ctx, transaction, PADROES.manualTaskBatchSize),
  ]);
  return {
    recoveryChecks: inteiro(checks, PADROES.recoveryChecks, LIMITES.recoveryChecks),
    assigneeRole: (parseRoles(assignee) || [PADROES.manualTaskAssigneeRole])[0],
    notifyRoles: parseRoles(notify) || [PADROES.notifyRoles],
    manualTaskDueH: inteiro(due, PADROES.manualTaskDueH, LIMITES.manualTaskDueH),
    drainBatchSize: inteiro(drain, PADROES.drainBatchSize, LIMITES.drainBatchSize),
    manualTaskBatchSize: inteiro(batch, PADROES.manualTaskBatchSize, LIMITES.manualTaskBatchSize),
  };
}

module.exports = { modeQueueMaxAgeH, readContingencyParams };
