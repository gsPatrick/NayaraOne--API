'use strict';

const { registerCaseSource } = require('../cases/caseSources');
const { makeItem } = require('../categoryEvaluators/common');
const { ADVERSARIAL, adversarialCases } = require('./cases');

let unregister = null;
/** A suíte adversarial entra na avaliação pela porta `registerCaseSource` (M9-D042); chamar duas vezes não duplica. */
function registerAdversarialSource() {
  if (!unregister) unregister = registerCaseSource(adversarialCases);
  return unregister;
}

/** Avalia um caso com sonda: a sonda devolve { passed, expected, actual, details }; erro da sonda reprova o caso. */
async function runProbeCase(caseDef, env) {
  try {
    const r = await caseDef.probe(env);
    return makeItem(caseDef, { expected: r.expected, actual: r.actual, passed: r.passed === true, details: { probe: caseDef.id, ...(r.details || {}) } });
  } catch (e) {
    return makeItem(caseDef, { expected: 'sonda executada', actual: 'falha na sonda', passed: false, details: { probe: caseDef.id, error: String((e && e.code) || 'PROBE_ERROR') } });
  }
}

module.exports = { registerAdversarialSource, runProbeCase, ADVERSARIAL, adversarialCases };
