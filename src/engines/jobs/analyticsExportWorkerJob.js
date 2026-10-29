'use strict';

const logger = require('../../utils/logger');
const { forEachCompany, runExportWorker } = require('../../features/analytics/exports');

/**
 * analyticsExportWorkerJob (Marco 9, M9-D701 3.3): a cada tique percorre as empresas e processa a fila de exportações do BI (QUEUED -> RUNNING -> READY ou
 * FAILED). A disputa entre processos é resolvida no banco (`FOR UPDATE SKIP LOCKED`): dois workers nunca executam o mesmo job. Falha de uma empresa não derruba as outras.
 */
const TICK_MS = 15 * 1000;

async function runAnalyticsExportWorkerJob(options = {}) {
  const summary = { processed: 0, failedCompanies: 0 };
  summary.failedCompanies = await forEachCompany('AnalyticsExportWorkerJob', async (scope) => {
    summary.processed += (await runExportWorker(scope, options)).length;
  });
  return summary;
}

function startAnalyticsExportWorkerJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsExportWorkerJob().catch((err) => {
      logger.error({ err }, '[AnalyticsExportWorkerJob] falha na execução agendada');
    }).finally(() => { running = false; });
  }, tickMs);
}

module.exports = { runAnalyticsExportWorkerJob, startAnalyticsExportWorkerJob };
