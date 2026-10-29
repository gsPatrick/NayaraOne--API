'use strict';

const logger = require('../../utils/logger');
const { cleanupWindows } = require('../../features/core-governance/api-governance/standards/rateLimit.counter');
const { STANDARDS_SETTING_DEFAULTS, CLEANUP_MINUTES_KEY } = require('../../features/core-governance/api-governance/standards/standards.settings');

/**
 * rateLimitCleanupJob (M9-D843 §3.1) — apaga as janelas do contador de requisições com mais de 10 minutos. Roda no intervalo padrão do catálogo
 * (governanca.api.limpeza_job_minutos, 10 min; o contador não tem empresa, então o intervalo é o do catálogo). Desligar no processo: RATE_LIMIT_CLEANUP_JOB_DISABLED=true.
 */
const runRateLimitCleanupJob = () => cleanupWindows();

function startRateLimitCleanupJob({ intervalMs = STANDARDS_SETTING_DEFAULTS[CLEANUP_MINUTES_KEY] * 60 * 1000 } = {}) {
  const tick = () => runRateLimitCleanupJob().catch((err) => logger.error({ err: err.message }, 'rateLimitCleanupJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runRateLimitCleanupJob, startRateLimitCleanupJob };
