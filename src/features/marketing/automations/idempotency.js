'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { createRunIdempotent } = require('../automationRuns.repository');
const { RUNNER_TIMEOUT_KEY, MARKETING_SETTING_DEFAULTS } = require('../marketing.settings');
const keys = require('./idempotency.keys');
const replay = require('./idempotency.replay');

/**
 * M9-D415 — idempotência das automações: chave da run, chave de cada ação, criação da run sem SELECT-antes-de-INSERT
 * (INSERT ... ON CONFLICT DO NOTHING no repositório da M9-D401) e plano de replay. O runner (M9-D414) usa estas funções.
 */

/** Cria (ou recupera, em replay) a run do evento. `replay: true` + MKT_RUN_REPLAY = HTTP 200, não é erro. */
async function startRun({ tenant, automationVersionId, eventId, triggerConfig, payload, subjectType, subjectId, correlationId }, { transaction } = {}) {
  const triggerEventId = keys.resolveTriggerEventId({ triggerConfig, payload, eventId });
  const idempotencyKey = keys.runIdempotencyKey({ automationVersionId, triggerEventId, subjectId });
  return createRunIdempotent(
    { groupId: tenant.groupId, companyId: tenant.companyId, automationVersionId, triggerEventId, subjectType, subjectId, correlationId, idempotencyKey },
    { transaction }
  );
}

async function getRunnerTimeoutS(tenant, transaction) {
  return getSetting(RUNNER_TIMEOUT_KEY, tenant, transaction, MARKETING_SETTING_DEFAULTS[RUNNER_TIMEOUT_KEY]);
}

module.exports = { ...keys, ...replay, startRun, getRunnerTimeoutS };
