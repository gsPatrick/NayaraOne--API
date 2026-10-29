'use strict';

/**
 * M9-D602 — tradução dos erros do banco para os erros de negócio dos alertas, qualidade e refresh.
 * ANA11 = transição inválida da instância; ANA12 = ação de pagamento; ANA13 = regra do Motor não publicada.
 */

const AppError = require('../../utils/AppError');
const { translateDbError } = require('./analyticsStoreSupport');

const MSG = {
  OWNER_REQUIRED: 'Todo alerta precisa de um responsável (owner).',
  CONDITION_INVALID: 'Informe um limite simples OU uma regra do Motor de Regras.',
  RULE_NOT_PUBLISHED: 'A regra escolhida não está publicada.',
  ACTION_FORBIDDEN: 'Alerta não pode disparar pagamento.',
  TASK_ONLY_CRITICAL: 'Somente alertas críticos podem criar tarefa ou ocorrência.',
  INSTANCE_ACTIVE: 'Já existe um alerta ativo para esta condição (mesmo fingerprint).',
  INSTANCE_TRANSITION: 'Esta mudança de estado do alerta não é permitida.',
  DEFINITION_CONFLICT: 'Já existe uma definição de alerta com este código e versão (ou outra já publicada).',
};

function mapAlertDbError(err) {
  const code = err?.original?.code || err?.parent?.code || err?.code;
  const constraint = err?.original?.constraint || err?.parent?.constraint || '';
  if (code === 'ANA11') return AppError.conflict(MSG.INSTANCE_TRANSITION, 'ANALYTICS_ALERT_INSTANCE_TRANSITION_INVALID');
  if (code === 'ANA12') return AppError.unprocessable(MSG.ACTION_FORBIDDEN, 'ANALYTICS_ALERT_ACTION_FORBIDDEN');
  if (code === 'ANA13') return AppError.unprocessable(MSG.RULE_NOT_PUBLISHED, 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
  if (code === '23514' && /alert_definitions_task_only_critical/.test(constraint)) return AppError.unprocessable(MSG.TASK_ONLY_CRITICAL, 'ANALYTICS_ALERT_TASK_ONLY_CRITICAL');
  if (code === '23514' && /alert_definitions_owner_required/.test(constraint)) return AppError.unprocessable(MSG.OWNER_REQUIRED, 'ANALYTICS_ALERT_OWNER_REQUIRED');
  if (code === '23514' && /alert_definitions_(condition_valid|threshold_shape)/.test(constraint)) {
    return AppError.unprocessable(MSG.CONDITION_INVALID, 'ANALYTICS_ALERT_CONDITION_INVALID');
  }
  if (code === '23503' && /alert_definitions_rule_id/.test(constraint)) return AppError.unprocessable(MSG.RULE_NOT_PUBLISHED, 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
  if (code === '23505' && /alert_instances_active_fingerprint_uq/.test(constraint)) return AppError.conflict(MSG.INSTANCE_ACTIVE, 'ANALYTICS_ALERT_INSTANCE_ACTIVE');
  if (code === '23505' && /alert_definitions/.test(constraint)) return AppError.conflict(MSG.DEFINITION_CONFLICT, 'ANALYTICS_ALERT_DEFINITION_CONFLICT');
  return null;
}

function translateAlertDbError(err) {
  if (err instanceof AppError) return err;
  const mapped = mapAlertDbError(err);
  if (mapped) {
    mapped.cause = err;
    return mapped;
  }
  return translateDbError(err);
}

async function runAlert(fn) {
  try {
    return await fn();
  } catch (err) {
    throw translateAlertDbError(err);
  }
}

module.exports = { MSG, translateAlertDbError, runAlert };
