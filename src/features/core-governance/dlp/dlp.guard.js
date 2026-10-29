'use strict';

const { allowsAi } = require('./policy.rules');
const { REASONS } = require('./guard.reasons');
const { CHECKS, NOT_APPLICABLE } = require('./dlp.constants');

/**
 * dlpGuard.evaluate (M9-D821 §3.1): função PURA (sem banco, sem relógio próprio) que percorre as etapas na ordem fixa
 * CLASSIFICATION -> PERMISSION -> PURPOSE -> MFA -> VOLUME -> DECISION; a primeira falha encerra e as seguintes ficam SKIPPED no rastro.
 * Modo leve (VIEW, COPY e AI, §3.1b): só as etapas 1, 2, 4 e 6; PURPOSE e VOLUME ficam NOT_APPLICABLE.
 *
 * request: { action, resourceType, purpose, justification, estimatedRows, mfaOk, aiAllowed, originPermission, watermarkRequested }
 * ctx:     { classification, policy, permissions[], suspendedUntil, now, purposes[], justificationMin }  (montado por guard.service.js)
 */
const STEPS = Object.freeze(['CLASSIFICATION', 'PERMISSION', 'PURPOSE', 'MFA', 'VOLUME', 'DECISION']);
const LIGHT_ACTIONS = Object.freeze(['VIEW', 'COPY', 'AI']);
const SUSPENDABLE_ACTIONS = Object.freeze(['EXPORT', 'SHARE', 'PRINT']);

const isLight = (action) => LIGHT_ACTIONS.includes(action);

function checkPermission(request, ctx) {
  const { policy, permissions, now } = ctx;
  if (policy.allowed === false || (request.action === 'AI' && !allowsAi(policy, request.aiAllowed))) return { reason: 'POLICY', check: 'POLICY' };
  if (SUSPENDABLE_ACTIONS.includes(request.action) && ctx.suspendedUntil && new Date(ctx.suspendedUntil) > now) {
    return { reason: 'SUSPENDED', check: 'SUSPENDED', until: new Date(ctx.suspendedUntil).toISOString() };
  }
  if (policy.requirePermission && !permissions.includes(policy.requirePermission)) return { reason: 'PERMISSION', check: 'PERMISSION', required: policy.requirePermission };
  if (request.originPermission && !permissions.includes(request.originPermission)) return { reason: 'PERMISSION', check: 'PERMISSION', required: request.originPermission };
  return null;
}

function checkPurpose(request, ctx) {
  if (!ctx.policy.requireJustification) return null;
  const purpose = typeof request.purpose === 'string' ? request.purpose.trim().toUpperCase() : '';
  const justification = typeof request.justification === 'string' ? request.justification.trim() : '';
  if (!ctx.purposes.includes(purpose)) return { reason: 'PURPOSE', check: CHECKS.PURPOSE_CATALOG };
  if (justification.length < ctx.justificationMin) return { reason: 'PURPOSE', check: CHECKS.JUSTIFICATION_MIN, min: ctx.justificationMin };
  return null;
}

const checkMfa = (request, ctx) => (ctx.policy.requireMfa && request.mfaOk !== true ? { reason: 'MFA' } : null);
const checkVolume = (request, ctx) => {
  const { maxRows } = ctx.policy;
  return maxRows !== null && maxRows !== undefined && Number(request.estimatedRows) > maxRows ? { reason: 'VOLUME', estimatedRows: Number(request.estimatedRows), maxRows } : null;
};

function obligations(request, ctx) {
  const { policy, now } = ctx;
  const hours = Number.isInteger(policy.maxExpiryHours) && policy.maxExpiryHours > 0 ? policy.maxExpiryHours : null;
  return {
    audit: Boolean(policy.requireAudit),
    watermark: Boolean(policy.requireWatermark) || request.watermarkRequested === true,
    mask: Boolean(policy.requireMask),
    expiresAt: hours ? new Date(now.getTime() + hours * 3600 * 1000).toISOString() : null,
    maxExpiryHours: hours,
  };
}

/** Etapa avaliada: devolve o motivo da falha (ou null); o rastro guarda o resultado de cada uma. */
const RUNNERS = Object.freeze({ PERMISSION: checkPermission, PURPOSE: checkPurpose, MFA: checkMfa, VOLUME: checkVolume });

function evaluate(request, ctx) {
  const light = isLight(request.action);
  const trace = [{ step: 'CLASSIFICATION', result: 'PASS', classification: ctx.classification }];
  let failure = null;
  for (const step of STEPS.slice(1, 5)) {
    if (light && (step === 'PURPOSE' || step === 'VOLUME')) { trace.push({ step, result: NOT_APPLICABLE }); continue; }
    if (failure) { trace.push({ step, result: 'SKIPPED' }); continue; }
    const found = RUNNERS[step](request, ctx);
    if (found) { failure = found; trace.push({ step, result: 'FAIL', ...found }); } else trace.push({ step, result: 'PASS' });
  }
  const base = { classification: ctx.classification, mode: light ? 'LIGHT' : 'FULL' };
  if (failure) {
    const reason = REASONS[failure.reason];
    trace.push({ step: 'DECISION', result: 'DENY', blockReason: failure.reason });
    return { ...base, decision: 'DENY', blockReason: failure.reason, errorCode: reason.errorCode, httpStatus: reason.httpStatus, trace, obligations: null };
  }
  const applied = obligations(request, ctx);
  trace.push({ step: 'DECISION', result: 'ALLOW', obligations: applied });
  return { ...base, decision: 'ALLOW', blockReason: null, errorCode: null, httpStatus: 200, trace, obligations: applied };
}

module.exports = { evaluate, STEPS, isLight };
