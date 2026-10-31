'use strict';

const providers = require('../control/blockers.providers');
const raci = require('../raci/raci.service');
const { accountableOf } = require('../control/blockers.rules');
const repo = require('./clock.repository');

const CODES = Object.freeze({ DRIFT: 'GOV_MIG_CLOCK_DRIFT', UNMEASURED: 'GOV_MIG_CLOCK_UNMEASURED' });

/**
 * Blocker da Torre pelo relógio fora da tolerância (M9-D901 §3.3 (f), M9-D908 §3.1): a conferência mais recente da empresa decide. Deriva acima do limite abre o
 * GOV_MIG_CLOCK_DRIFT; relógio não medido abre o GOV_MIG_CLOCK_UNMEASURED; uma conferência seguinte dentro do limite fecha o blocker. Responsável: o A da atividade CLOCK_TZ_CHECK.
 */
async function clockBlockers(tenant, scope, transaction) {
  const last = await repo.latest(tenant, transaction);
  if (!last || last.status === 'OK') return [];
  const matrix = await raci.getMatrix(tenant, transaction);
  const owner = accountableOf(matrix.activities.find((activity) => activity.code === 'CLOCK_TZ_CHECK'));
  return [{
    code: last.status === 'DRIFT' ? CODES.DRIFT : CODES.UNMEASURED, entity: null, ref: 'relogio', owner,
    detail: { drift_ms: last.driftMs, max_drift_ms: last.maxDriftMs, checked_at: last.checkedAt, systems: last.readings.map((reading) => ({ system: reading.system, offset_ms: reading.offsetMs === undefined ? null : reading.offsetMs, error: reading.error || null })) },
  }];
}

providers.register('migration-clock', clockBlockers);

module.exports = { CODES, clockBlockers };
