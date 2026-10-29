'use strict';

/** Constantes do golden dataset (M9-D033). Sem regra variável: os limites variáveis estão em regression.settings.js. */
const STATUSES = Object.freeze(['ACTIVE', 'RETIRED']);
const KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const INPUT_MAX = 4000;
const EVENTS = Object.freeze({ created: 'ai.golden_case.created', retired: 'ai.golden_case.retired' });

/** Chaves aceitas em `expected` por categoria (o resto é recusado: nada de campo solto). */
const EXPECTED_KEYS = Object.freeze({
  GROUNDING: ['contains'],
  HALLUCINATION: ['insufficient'],
  TOOL_SELECTION: ['tool', 'tools'],
  PERMISSIONS: ['blocked'],
  INJECTION: ['detected'],
  COST: ['maxCostMicros'],
  LATENCY: ['maxLatencyMs'],
});

/** Chaves aceitas em `fixtures` por categoria. */
const FIXTURE_KEYS = Object.freeze({
  GROUNDING: ['sources'],
  HALLUCINATION: ['sources'],
  TOOL_SELECTION: [],
  PERMISSIONS: ['toolName', 'actorPermissions'],
  INJECTION: [],
  COST: [],
  LATENCY: [],
});

module.exports = { STATUSES, KEY_RE, INPUT_MAX, EVENTS, EXPECTED_KEYS, FIXTURE_KEYS };
