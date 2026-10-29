'use strict';

/**
 * M9-D407 — Finding do validador factual: { kind, claim, expected, found, severity: 'BLOCK', reason, message } (+ field no INJECTION).
 * reason: MISMATCH (divergente do cadastro), MISSING (o cadastro não tem o dado), UNEXPLAINED (afirmação sem lastro) e INJECTION.
 */
const KINDS = Object.freeze(['NUMBER', 'PRICE', 'AREA', 'ROOMS', 'ADDRESS', 'FEATURE', 'UNKNOWN_CLAIM', 'INJECTION_SUSPECT']);
const MISSING_MESSAGE = 'dado inexistente, a IA não inventa';

function finding({ kind, claim, expected = null, found = null, reason, message, field }) {
  const out = { kind, claim, expected, found, severity: 'BLOCK', reason, message };
  if (field !== undefined) out.field = field;
  return out;
}

/** Divergente ou inexistente, conforme o cadastro tenha ou não o dado. */
function mismatchOrMissing({ kind, claim, expected, found, hasData, label }) {
  if (!hasData) return finding({ kind, claim, expected: null, found, reason: 'MISSING', message: `O cadastro não tem ${label}: ${MISSING_MESSAGE}.` });
  return finding({ kind, claim, expected, found, reason: 'MISMATCH', message: `O texto cita ${label} diferente do cadastro.` });
}

module.exports = { KINDS, MISSING_MESSAGE, finding, mismatchOrMissing };
