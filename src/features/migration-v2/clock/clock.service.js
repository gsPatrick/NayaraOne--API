'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const readers = require('./clock.readers');
const repo = require('./clock.repository');
const { KEYS, CLOCK_SETTING_DEFAULTS } = require('./clock.settings');

const STATUS = Object.freeze({ OK: 'OK', DRIFT: 'DRIFT', UNMEASURED: 'UNMEASURED' });
const maxDriftMs = async (tenant, transaction) => Number(await getSetting(KEYS.MAX_DRIFT_S, tenant, transaction, CLOCK_SETTING_DEFAULTS[KEYS.MAX_DRIFT_S])) * 1000;

/** Roda os leitores registrados e junta as leituras (cada falha vira { system, error }). A aplicação é a referência (deslocamento 0). */
async function collect(tenant, options) {
  const readings = [{ system: 'APP', offsetMs: 0 }];
  const results = await Promise.all(readers.list().map(async ([name, fn]) => {
    try { return await fn({ tenant, connectors: options.connectors }); } catch (err) { return [{ system: name, error: err.code || err.message || 'CLOCK_UNREADABLE' }]; }
  }));
  for (const part of results) readings.push(...(Array.isArray(part) ? part : [part]));
  return readings.map((reading) => (reading.error ? { system: reading.system, error: String(reading.error).slice(0, 80) } : { system: reading.system, offsetMs: reading.offsetMs }));
}

/** Estado da conferência: deriva = maior diferença entre quaisquer dois relógios medidos. Acima do limite é DRIFT (mesmo com leitura faltando); leitura faltando abaixo dele é UNMEASURED. */
function evaluate(readings, limitMs) {
  const measured = readings.filter((reading) => typeof reading.offsetMs === 'number').map((reading) => reading.offsetMs);
  const driftMs = measured.length ? Math.max(...measured) - Math.min(...measured) : null;
  if (driftMs !== null && driftMs > limitMs) return { driftMs, status: STATUS.DRIFT };
  return { driftMs, status: readings.some((reading) => reading.error) ? STATUS.UNMEASURED : STATUS.OK };
}

/**
 * Confere os relógios (M9-D908 §3.1): aplicação, banco de destino, NTP e fonte antiga. Grava a conferência (a mais recente é a que abre ou fecha o blocker da Torre) e devolve
 * { status, driftMs, maxDriftMs, readings }. `options`: { context (BATCH, DRY3, RECHECK, MANUAL), runId, dryRunId, connectors }.
 */
async function check(tenant, options = {}) {
  const limitMs = await openTenantTx(tenant, (transaction) => maxDriftMs(tenant, transaction));
  const readings = await collect(tenant, options);
  const verdict = evaluate(readings, limitMs);
  const saved = await openTenantTx(tenant, async (transaction) => {
    const row = await repo.insert(tenant, { context: options.context || 'MANUAL', runId: options.runId, dryRunId: options.dryRunId, readings, driftMs: verdict.driftMs, maxDriftMs: limitMs, status: verdict.status }, transaction);
    if (verdict.status !== STATUS.OK) {
      await registrarAuditoria({
        groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'migration.clock.check.failed', entityType: 'MigClockCheck', entityId: row.id,
        afterJson: { status: verdict.status, driftMs: verdict.driftMs, maxDriftMs: limitMs, systems: readings.map((reading) => reading.system) }, reason: 'Conferência de relógio fora do limite ou incompleta.',
      }, transaction);
    }
    return row;
  });
  return { id: saved.id, status: verdict.status, driftMs: verdict.driftMs, maxDriftMs: limitMs, readings, checkedAt: saved.checkedAt };
}

const latest = (tenant, transaction) => repo.latest(tenant, transaction);

module.exports = { check, latest, evaluate, STATUS };
