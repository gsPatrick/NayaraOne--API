'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const runs = require('../ingest/run.repository');
const clock = require('./clock.service');
const repo = require('./clock.repository');
const { KEYS, CLOCK_SETTING_DEFAULTS } = require('./clock.settings');

const MIN_MS = 60 * 1000;

/**
 * Retomada automática (M9-D908 §3.1): com execução PAUSED ou deriva aberta, a conferência se repete a cada `migracao.relogio.reverificar_min`; ao medir dentro do limite as
 * execuções PAUSED voltam a QUEUED e o job de execução as retoma sozinho, do último checkpoint. Devolve { checked, status, resumed }. `now` é injetável (testes).
 */
async function recheckAndResume(tenant, { now = new Date() } = {}) {
  const state = await openTenantTx(tenant, async (transaction) => ({
    paused: await runs.listPaused(tenant, transaction), last: await repo.latest(tenant, transaction),
    everyMin: Number(await getSetting(KEYS.RECHECK_MIN, tenant, transaction, CLOCK_SETTING_DEFAULTS[KEYS.RECHECK_MIN])),
  }));
  const open = state.paused.length > 0 || (state.last && state.last.status !== 'OK');
  if (!open) return { checked: false, status: state.last ? state.last.status : null, resumed: [] };
  if (state.last && now - new Date(state.last.checkedAt) < state.everyMin * MIN_MS) return { checked: false, status: state.last.status, resumed: [] };
  const result = await clock.check(tenant, { context: 'RECHECK' });
  if (result.status !== clock.STATUS.OK || !state.paused.length) return { checked: true, status: result.status, resumed: [] };
  const resumed = await openTenantTx(tenant, async (transaction) => {
    const ids = [];
    for (const run of state.paused) {
       
      if (await runs.resume(tenant, run.id, transaction)) {
        ids.push(run.id);
         
        await registrarAuditoria({
          groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'migration.run.resumed', entityType: 'MigRun', entityId: run.id,
          afterJson: { status: 'QUEUED', driftMs: result.driftMs }, reason: 'Relógios de volta ao limite: execução retomada do último checkpoint.',
        }, transaction);
      }
    }
    return ids;
  });
  return { checked: true, status: result.status, resumed };
}

module.exports = { recheckAndResume };
