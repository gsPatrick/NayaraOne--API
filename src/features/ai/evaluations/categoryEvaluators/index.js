'use strict';

const { evaluateGrounding, evaluateHallucination } = require('./grounding');
const { evaluateToolSelection, evaluatePermissions } = require('./tools');
const { evaluateInjection } = require('./injection');

/** Avaliador de cada categoria com caso próprio. COST e LATENCY saem das chamadas ao modelo (evaluationMetrics). */
const EVALUATORS = Object.freeze({
  GROUNDING: evaluateGrounding,
  HALLUCINATION: evaluateHallucination,
  TOOL_SELECTION: evaluateToolSelection,
  PERMISSIONS: evaluatePermissions,
  INJECTION: evaluateInjection,
});

module.exports = { EVALUATORS };
