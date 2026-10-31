'use strict';

const { VIEW_RESTRICTED_PERMISSION } = require('../dlp/dlp.constants');
const { DEFAULT_MASKING } = require('./classification.constants');

/**
 * Regra de acesso por campo e por contexto (M9-D915 §3.1 a §3.4), PURA. Entrada: a linha do registro (`spec`), o ator e o contexto. Saída: { outcome, reason, guard }:
 *   CLEAR (o valor sai em claro), MASKED (sai com a máscara do registro) ou OMITTED (o campo some); `guard` é a ação de DLP (VIEW, COPY ou AI) que o chamador ainda precisa
 * consultar e que, se negar, rebaixa CLEAR para MASKED (ou OMITTED, na IA). Os contextos SCREEN, API e COPY são o mesmo; COPY só troca a ação consultada.
 */
const CONTEXTS = Object.freeze(['SCREEN', 'API', 'COPY', 'EXPORT', 'PRINT', 'AI', 'LOG']);
const SENSITIVE = Object.freeze(['HIGH', 'RESTRICTED']);
const isSensitive = (classification) => SENSITIVE.includes(classification);

const result = (outcome, reason, guard = null) => ({ outcome, reason, guard });

function canViewRestricted(actor, opts) {
  const permissions = (actor && actor.permissions) || [];
  return permissions.includes(VIEW_RESTRICTED_PERMISSION) && (!opts.originPermission || permissions.includes(opts.originPermission));
}

function onScreen(spec, actor, context, opts) {
  if (!isSensitive(spec.classification)) return result('CLEAR', 'NOT_SENSITIVE');
  if (spec.classification === 'RESTRICTED' && !canViewRestricted(actor, opts)) return result('MASKED', 'RESTRICTED_NO_PERMISSION');
  return result('CLEAR', 'PERMITTED', context === 'COPY' ? 'COPY' : 'VIEW');
}

function onFile(spec, actor, opts) {
  if (spec.exportability === 'FORBIDDEN') return result('OMITTED', 'EXPORT_FORBIDDEN');
  if (spec.exportability === 'ALLOWED_MASKED') return result('MASKED', 'EXPORT_MASKED');
  if (spec.exportability === 'WITH_APPROVAL' && opts.approved !== true) return result('MASKED', 'EXPORT_NEEDS_APPROVAL');
  if (spec.classification === 'RESTRICTED' && !canViewRestricted(actor, opts)) return result('MASKED', 'RESTRICTED_NO_PERMISSION');
  return result('CLEAR', spec.exportability === 'WITH_APPROVAL' ? 'APPROVED' : 'EXPORT_ALLOWED');
}

function forAi(spec, opts) {
  if (spec.classification === 'RESTRICTED') return result('OMITTED', 'AI_RESTRICTED');
  if (spec.aiAllowed !== true) return result('OMITTED', 'AI_NOT_ALLOWED');
  const clearAgent = !isSensitive(spec.classification) && Array.isArray(opts.clearAgents) && opts.agent && opts.clearAgents.includes(String(opts.agent).toUpperCase());
  if (clearAgent || (spec.masking === 'NONE' && !isSensitive(spec.classification))) return result('CLEAR', clearAgent ? 'AI_CLEAR_AGENT' : 'AI_NO_MASK', 'AI');
  return result('MASKED', 'AI_MASKED', 'AI');
}

function decide(spec, actor, context, opts = {}) {
  if (context === 'AI') return forAi(spec, opts);
  if (context === 'EXPORT' || context === 'PRINT') return onFile(spec, actor, opts);
  if (context === 'LOG') return isSensitive(spec.classification) ? result('MASKED', 'LOG_ALWAYS_MASKED') : result('CLEAR', 'NOT_SENSITIVE');
  return onScreen(spec, actor, context, opts);
}

/** A máscara que vale quando o valor sai mascarado: a do registro; campo HIGH ou RESTRICTED com máscara NONE usa a parcial padrão, e RESTRICTED em log sai inteiro. */
function effectiveMasking(spec, context) {
  if (context === 'LOG' && spec.classification === 'RESTRICTED') return 'FULL';
  return spec.masking === 'NONE' && isSensitive(spec.classification) ? DEFAULT_MASKING : spec.masking;
}

module.exports = { decide, effectiveMasking, canViewRestricted, isSensitive, CONTEXTS };
