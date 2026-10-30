'use strict';

const constants = require('./runner.constants');
const ports = require('./runner.ports');
const settings = require('./runner.settings');
const { processEvent, replayRun } = require('./runner.service');
const { runDueActions, recoverStuckRuns, isRunStuck } = require('./runner.due');
const { runScheduleTick, cronMatches } = require('./runner.schedule');
const { registerRunnerConsumers, consumedEventTypes } = require('./runner.consumer');
const { resolveSubject } = require('./runner.subject');
const { registerCadenceDue } = require('./runner.plan');
const registry = require('./runner.registry');

registerRunnerConsumers(); // M9-D414 passo 1: consome do outbox os eventos do catálogo de gatilhos

/** Automation runner (M9-D414): os 9 passos, o executor das ações adiadas, o tick de agenda e as portas para outras áreas. */
module.exports = {
  processEvent, replayRun, runDueActions, recoverStuckRuns, runScheduleTick, cronMatches, isRunStuck, resolveSubject, consumedEventTypes, registerCadenceDue, registerTriggerFilter: registry.registerTriggerFilter, registerScheduleExpander: registry.registerScheduleExpander, registerLinkProvider: ports.registerLinkProvider,
  registerRunnerPorts: ports.registerRunnerPorts,
  reviewPort: { registerReviewRequester: ports.registerReviewRequester, clearReviewRequester: ports.clearReviewRequester },
  RUNNER_SETTINGS_SCHEMA: settings.RUNNER_SETTINGS_SCHEMA, RUNNER_SETTING_DEFAULTS: settings.RUNNER_SETTING_DEFAULTS, readRunnerParams: settings.readRunnerParams,
  ...constants,
};
