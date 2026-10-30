'use strict';

/**
 * M9-D414 — vocabulário do runner. Os 17 motivos de `blocked_reason` do livro, em duas classes: bloqueio de ENVIO (a mensagem fica SKIPPED e as ações internas
 * executam) e bloqueio de APLICABILIDADE (a automação não se aplica: nenhuma ação executa). QUIET_HOURS não é motivo de bloqueio: é adiamento.
 */
const SEND_BLOCK_REASONS = Object.freeze([
  'KILL_SWITCH', 'SUPPRESSED', 'OPT_OUT', 'NO_ADDRESS', 'NO_CONSENT', 'CHANNEL_POLICY', 'FREQUENCY_CAP', 'COOLDOWN', 'NO_CONTACT_CHANNEL', 'EXPIRED',
]);
const APPLICABILITY_REASONS = Object.freeze([
  'CONDITION_FALSE', 'CONDITION_ERROR', 'OUTSIDE_VALIDITY', 'AUTOMATION_PAUSED', 'CAMPAIGN_NOT_RUNNING', 'CROSS_COMPANY', 'CONTRACT_NOT_ACTIVE',
]);
const BLOCKED_REASONS = Object.freeze([...SEND_BLOCK_REASONS, ...APPLICABILITY_REASONS]);
const INTERNAL_ACTIONS = Object.freeze(['CREATE_TASK', 'NOTIFY_USER', 'CREATE_CONTENT_DRAFT', 'REQUEST_REVIEW', 'OPEN_CASE', 'UPDATE_CRM_STAGE_TAG']);
const RECEIPT_ACTIONS = Object.freeze(['NOTIFY_USER', 'CREATE_CONTENT_DRAFT', 'REQUEST_REVIEW', 'OPEN_CASE', 'UPDATE_CRM_STAGE_TAG']);
const CONSUMER_NAME = 'marketing.automation.runner';
const SEND = 'SEND_MESSAGE';
const STEPS = Object.freeze({
  1: 'RECEIVE', 2: 'RESOLVE_VERSION', 3: 'SUPPRESSION_CONSENT', 4: 'COOLDOWN', 5: 'CONDITIONS', 6: 'IDEMPOTENCY_KEY', 7: 'EXECUTE_ACTIONS', 8: 'RECORD_RESULTS', 9: 'EMIT',
});
const MESSAGE_PURPOSE_DEFAULT = 'MARKETING';
/** Código da ação de cadência sem dia na lista (a lista do parâmetro tem menos itens que as mensagens da automação). */
const NO_CADENCE_DAY = 'NO_CADENCE_DAY';

module.exports = { SEND_BLOCK_REASONS, APPLICABILITY_REASONS, BLOCKED_REASONS, INTERNAL_ACTIONS, RECEIPT_ACTIONS, CONSUMER_NAME, SEND, STEPS, MESSAGE_PURPOSE_DEFAULT, NO_CADENCE_DAY };
