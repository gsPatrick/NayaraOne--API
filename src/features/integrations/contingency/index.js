'use strict';

/** Framework de contingência das integrações (Marco 9, M9-D226). Fachada da API pública; `installContingency` liga os ganchos no boot. */
const { registerDispatchCycleStep } = require('../dispatch/worker/worker.hooks');
const { FAMILY_DEFAULT_MODE, MODES, EVENTS, REASONS } = require('./contingency.constants');
const { CONTINGENCY_SETTINGS_SCHEMA } = require('./contingency.settings');
const { resolveContingencyPolicy, resolvePolicyFor } = require('./contingency.policy');
const { contingencyProblems } = require('./contingency.policyRules');
const { activateContingency, deactivateContingency } = require('./contingency.activate');
const { findActive, listActiveRows, toView } = require('./contingency.state');
const { listActiveContingencies } = require('./contingency.list');
const { checkAlternate, assertAlternate } = require('./contingency.alternate');
const { switchToAlternate } = require('./contingency.switch');
const { isAlternateSafe } = require('./contingency.alternateSafe');
const { runContingencyCycle } = require('./contingency.cycle');
const { tryRecover } = require('./contingency.recovery');
const { drainQueue } = require('./contingency.drain');
const { readContingencyParams, modeQueueMaxAgeH } = require('./contingency.params');
const { onManualTask } = require('./contingency.manualTask');
const { registerFamilyHandlers } = require('./contingency.handlers');

let installed = false;

/** Liga o gancho das famílias (circuito aberto e família sem connection) e o passo da rodada do worker de envios. Idempotente. */
function installContingency() {
  registerFamilyHandlers(); // o registro substitui o gancho da mesma família: repetir não duplica
  if (!installed) { registerDispatchCycleStep(runContingencyCycle); installed = true; }
}

module.exports = {
  installContingency, runContingencyCycle, activateContingency, deactivateContingency, tryRecover, drainQueue, findActive, listActiveRows, listActiveContingencies, toView,
  resolveContingencyPolicy, resolvePolicyFor, contingencyProblems, checkAlternate, assertAlternate, switchToAlternate, isAlternateSafe, readContingencyParams, modeQueueMaxAgeH,
  onManualTask, CONTINGENCY_SETTINGS_SCHEMA, FAMILY_DEFAULT_MODE, MODES, EVENTS, REASONS,
};
