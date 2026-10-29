'use strict';

const { startRun, finishRun } = require('./runLifecycle');
const { recordRunProgress } = require('./runProgress');
const { recordSource } = require('./runSources');
const { getRun } = require('./runReader');
const { recordRuleRun } = require('./ruleRunRecorder');
const { computeRunCost } = require('./runCost');
const constants = require('./runs.constants');

/** Registro de execução da NAY (M9-D005): ai.ai_runs e ai.ai_sources. */
module.exports = { startRun, finishRun, recordRunProgress, recordSource, getRun, recordRuleRun, computeRunCost, constants };
