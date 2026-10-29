'use strict';

const { evaluateGrounding, evaluateHallucination } = require('./grounding');
const { evaluateToolSelection, evaluatePermissions } = require('./tools');
const { evaluateInjection } = require('./injection');
const { evaluateCost, evaluateLatency } = require('./costLatency');

/** Avaliador de cada categoria com caso próprio. O resumo de COST e LATENCY sai de todas as chamadas ao modelo (evaluationMetrics); o caso dessas duas só confere a própria chamada. */
const EVALUATORS = Object.freeze({
  GROUNDING: evaluateGrounding,
  HALLUCINATION: evaluateHallucination,
  TOOL_SELECTION: evaluateToolSelection,
  PERMISSIONS: evaluatePermissions,
  INJECTION: evaluateInjection,
  COST: evaluateCost,
  LATENCY: evaluateLatency,
});

module.exports = { EVALUATORS };
