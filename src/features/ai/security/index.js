'use strict';

const { createPiiRedactor, redactForStorage, redactDeepForStorage, RedactionMap } = require('./piiRedactor');
const { applyClassificationGate, decide } = require('./classificationGate');
const { registerTaskType, getTaskType, unregisterTaskType } = require('./taskTypes');
const { buildPrompt } = require('./promptBuilder');
const { buildContext } = require('./contextBuilder');

/** Privacidade da NAY (M9-D027): redaction `[REDIGIDO:tipo]`, minimização, portão de classificação e ContextBuilder. */
module.exports = {
  createPiiRedactor, redactForStorage, redactDeepForStorage, RedactionMap, applyClassificationGate, decide,
  registerTaskType, getTaskType, unregisterTaskType, buildPrompt, buildContext,
};
