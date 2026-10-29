'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const { cleanupExpired } = require('../../features/core-governance/api-governance/standards/idempotency.repository');
const { STANDARDS_SETTING_DEFAULTS, CLEANUP_MINUTES_KEY } = require('../../features/core-governance/api-governance/standards/standards.settings');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * idempotencyCleanupJob (M9-D843 §5) — apaga as chaves de idempotência vencidas (passadas da validade, 24 h por padrão). Confere a cada minuto e roda por empresa no intervalo
 * de `governanca.api.limpeza_job_minutos` (padrão 10). Desligar no processo: IDEMPOTENCY_CLEANUP_JOB_DISABLED=true.
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function runIdempotencyCleanupJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('idempotencyCleanupJob', async (tenant, transaction) => {
    const minutes = Number(await getSetting(CLEANUP_MINUTES_KEY, tenant, transaction, STANDARDS_SETTING_DEFAULTS[CLEANUP_MINUTES_KEY]));
    if (!force && now.getTime() - (lastRun.get(tenant.companyId) || 0) < minutes * 60000) return null;
    lastRun.set(tenant.companyId, now.getTime());
    return { removed: await cleanupExpired([tenant.companyId]) };
  }, 'api-governance');
}

function startIdempotencyCleanupJob({ intervalMs = TICK_MS } = {}) {
  const tick = () => runIdempotencyCleanupJob().catch((err) => logger.error({ err: err.message }, 'idempotencyCleanupJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runIdempotencyCleanupJob, startIdempotencyCleanupJob };
