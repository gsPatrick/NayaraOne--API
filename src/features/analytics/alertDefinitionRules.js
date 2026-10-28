'use strict';

/**
 * M9-D602 — validação da definição de alerta antes de ir ao banco (mesmas regras dos CHECKs e gatilhos,
 * para devolver a mensagem do livro). O banco continua sendo a trava final.
 */

const AppError = require('../../utils/AppError');
const { invalid, requireOneOf, isPlainObject } = require('./analyticsStoreSupport');
const { MSG } = require('./alertErrors');

const CODE = 'ANALYTICS_ALERT_INVALID';
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];
const OPERATORS = ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'];
const CONDITION_TYPES = ['THRESHOLD', 'RULE_ENGINE'];
const ALERT_CODE_RE = /^[a-z][a-z0-9_]*$/;
const METRIC_CODE_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const PAYMENT_KEY_RES = [/(pagament|payment|payout|boleto)/i, /^(pay|pagar|pix|transfer|transferencia)$/i, /^(pay|pagar|pix|transfer|transferencia)[A-Z_-]/];
const ACTION_INPUT_KEYS = ['action', 'actions', 'onTrigger'];

/** Chave de pagamento em qualquer profundidade (espelha analytics.jsonb_has_payment_keys). */
function hasPaymentKey(value) {
  if (Array.isArray(value)) return value.some(hasPaymentKey);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => PAYMENT_KEY_RES.some((re) => re.test(key)) || hasPaymentKey(inner));
  }
  return false;
}

const forbidden = () => AppError.unprocessable(MSG.ACTION_FORBIDDEN, 'ANALYTICS_ALERT_ACTION_FORBIDDEN');
const conditionInvalid = () => AppError.unprocessable(MSG.CONDITION_INVALID, 'ANALYTICS_ALERT_CONDITION_INVALID');

function assertNoPaymentAction(input) {
  const payloads = [input.scope, input.autoResolvePolicy, input.threshold, ...ACTION_INPUT_KEYS.map((k) => input[k])];
  if (payloads.some(hasPaymentKey)) throw forbidden();
  for (const key of ACTION_INPUT_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const text = JSON.stringify(value);
    if (/(pagament|payment|payout|boleto|\bpix\b|\bpay\b)/i.test(text)) throw forbidden();
  }
}

function assertOwner(input) {
  const hasRole = typeof input.ownerRole === 'string' && input.ownerRole.trim().length > 0;
  if (!input.ownerUserId && !hasRole) throw AppError.unprocessable(MSG.OWNER_REQUIRED, 'ANALYTICS_ALERT_OWNER_REQUIRED');
}

function assertCondition(input) {
  requireOneOf(input.conditionType, CONDITION_TYPES, 'Tipo de condição', CODE);
  const hasThreshold = input.threshold !== undefined && input.threshold !== null;
  const hasRule = Boolean(input.ruleId);
  if (hasThreshold === hasRule) throw conditionInvalid();
  if (input.conditionType === 'THRESHOLD' && !hasThreshold) throw conditionInvalid();
  if (input.conditionType === 'RULE_ENGINE' && !hasRule) throw conditionInvalid();
  if (hasThreshold && !(isPlainObject(input.threshold) && OPERATORS.includes(input.threshold.operator) && typeof input.threshold.value === 'number'
    && Number.isFinite(input.threshold.value))) {
    throw conditionInvalid();
  }
}

function assertAutoResolve(policy) {
  if (policy === undefined || policy === null) return;
  if (!isPlainObject(policy)) throw invalid(CODE, 'A política de resolução automática deve ser um objeto.');
  const n = policy.consecutiveOkEvaluations;
  if (n !== undefined && !(Number.isInteger(n) && n >= 1)) throw invalid(CODE, 'consecutiveOkEvaluations deve ser um inteiro a partir de 1.');
}

/** Valida a definição inteira. Ordem: pagamento, owner, condição (as três recusas do livro), depois o resto. */
function validateAlertDefinition(input) {
  assertNoPaymentAction(input);
  assertOwner(input);
  assertCondition(input);
  if (typeof input.alertCode !== 'string' || !ALERT_CODE_RE.test(input.alertCode)) {
    throw invalid(CODE, 'O código do alerta deve usar minúsculas, números e "_", começando por letra.');
  }
  if (typeof input.metricCode !== 'string' || !METRIC_CODE_RE.test(input.metricCode)) {
    throw invalid(CODE, 'O código da métrica deve seguir o formato dominio.nome_em_snake.');
  }
  requireOneOf(input.severity, SEVERITIES, 'Severidade', CODE);
  if (input.metricVersionPin != null && !(Number.isInteger(input.metricVersionPin) && input.metricVersionPin >= 1)) {
    throw invalid(CODE, 'A versão fixada da métrica deve ser um inteiro a partir de 1 (vazio = versão vigente).');
  }
  if (input.cooldownMinutes != null && !(Number.isInteger(input.cooldownMinutes) && input.cooldownMinutes >= 0)) {
    throw invalid(CODE, 'O cooldown deve ser um inteiro de minutos a partir de 0 (vazio = padrão da severidade).');
  }
  assertAutoResolve(input.autoResolvePolicy);
  if (input.scope !== undefined && !isPlainObject(input.scope)) throw invalid(CODE, 'O escopo do alerta deve ser um objeto.');
}

module.exports = { validateAlertDefinition, hasPaymentKey, SEVERITIES };
