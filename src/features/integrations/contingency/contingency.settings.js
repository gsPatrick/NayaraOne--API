'use strict';

const AppError = require('../../../utils/AppError');
const { parseRoles } = require('../health/alerts/alerts.limits');
const { LIMITES } = require('./contingency.limits');

/**
 * Parâmetros da contingência (M9-D226): dicionário fail-closed de SETTINGS_SCHEMA; a leitura com os padrões está em contingency.params.js.
 * O prazo da fila (`queue_max_age_h`) é por modo; o banco usa a régua única `integration.bank.max_pending_hours` (INT-P082).
 */
const rolesSpec = {
  type: 'string',
  validate: (key, value) => {
    if (!parseRoles(value)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de nomes de papel separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
  },
};
const horas = (lim) => ({ type: 'integer', min: lim.min, max: lim.max });

const CONTINGENCY_SETTINGS_SCHEMA = Object.freeze({
  'integration.contingency.recovery_checks': horas(LIMITES.recoveryChecks),
  'integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE': horas(LIMITES.queueMaxAgeH),
  'integration.contingency.queue_max_age_h.KEEP_INTERNAL_AND_REPROCESS': horas(LIMITES.queueMaxAgeH),
  'integration.contingency.queue_max_age_h.PRESERVE_AND_ALTERNATE_FLOW': horas(LIMITES.queueMaxAgeH),
  'integration.contingency.queue_max_age_h.QUEUE_QUERY_OR_ALTERNATE_PROVIDER': horas(LIMITES.queueMaxAgeH),
  'integration.bank.max_pending_hours': horas(LIMITES.bankMaxPendingH),
  'integration.contingency.manual_task_assignee_role': rolesSpec,
  'integration.contingency.notify_roles': rolesSpec,
  'integration.contingency.manual_task_due_h': horas(LIMITES.manualTaskDueH),
  'integration.contingency.drain_batch_size': horas(LIMITES.drainBatchSize),
  'integration.contingency.manual_task_batch_size': horas(LIMITES.manualTaskBatchSize),
});

module.exports = { CONTINGENCY_SETTINGS_SCHEMA };
