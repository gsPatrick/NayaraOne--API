'use strict';

const logger = require('../../utils/logger');
const { forEachCompany, runExportCleanup } = require('../../features/analytics/exports');

/**
 * analyticsExportCleanupJob (Marco 9, M9-D701 3.4): apaga o arquivo das exportações vencidas (READY -> EXPIRED) e dá como falho o job que ficou em andamento
 * além do limite (worker que morreu). Falha de uma empresa não derruba as outras.
 */
const TICK_MS = 60 * 1000;

async function runAnalyticsExportCleanupJob(options = {}) {
  const summary = { expired: 0, timedOut: 0, failedCompanies: 0 };
  summary.failedCompanies = await forEachCompany('AnalyticsExportCleanupJob', async (scope) => {
    const out = await runExportCleanup(scope, options);
    summary.expired += out.expired;
    summary.timedOut += out.timedOut;
  });
  return summary;
}

function startAnalyticsExportCleanupJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsExportCleanupJob().catch((err) => {
      logger.error({ err }, '[AnalyticsExportCleanupJob] falha na execução agendada');
    }).finally(() => { running = false; });
  }, tickMs);
}

module.exports = { runAnalyticsExportCleanupJob, startAnalyticsExportCleanupJob };
