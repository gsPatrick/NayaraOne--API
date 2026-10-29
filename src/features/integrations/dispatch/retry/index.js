'use strict';

/** Nova tentativa por classe de erro (Marco 9, M9-D216). Ao carregar, registra o tratador de falha no worker de envios. */
const { registerFailureHandler } = require('../worker/worker.hooks');
const { handleClassifiedFailure } = require('./retry.handler');
const { classifyDispatchError } = require('./retry.classify');
const { backoffMs, backoffRangeMs, parseRetryAfterMs } = require('./retry.delay');
const { mergePolicies, resolveEffectivePolicy, resolveEffectivePolicyById } = require('./retry.policy');
const { validatePolicyJson, RETRY_LIMITS, RATE_LIMIT_LIMITS } = require('./retry.limits');
const { readRetryParams, PADROES } = require('./retry.params');
const { resumeAuthFailedDispatches } = require('./retry.resume');
const { registerUnknownReconciler } = require('./retry.unknown');

registerFailureHandler(handleClassifiedFailure);

module.exports = {
  handleClassifiedFailure, classifyDispatchError, backoffMs, backoffRangeMs, parseRetryAfterMs, mergePolicies, resolveEffectivePolicy, resolveEffectivePolicyById,
  validatePolicyJson, RETRY_LIMITS, RATE_LIMIT_LIMITS, readRetryParams, RETRY_PADROES: PADROES, resumeAuthFailedDispatches, registerUnknownReconciler,
};
