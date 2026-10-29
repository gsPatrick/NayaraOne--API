'use strict';

const logger = require('../../utils/logger');
const { expireCompany, removeFromDisk } = require('../../features/core-governance/dlp/exports/export.expiry');
const { readExportParams } = require('../../features/core-governance/dlp/exports/export.params');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * exportExpiryJob (M9-D822 §3.2) — expira os arquivos de exportação vencidos (apaga o arquivo e mantém o hash) e dá por falhas as gerações paradas. Confere a cada minuto e roda
 * por empresa no intervalo de `governanca.dlp.exportacao.job_expiracao_minutos` (padrão 15). Desligar no processo: DLP_EXPORT_EXPIRY_JOB_DISABLED=true.
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function runExportExpiryJob(now = new Date(), { force = false } = {}) {
  const keys = [];
  const result = await runForEachCompany('exportExpiryJob', async (tenant, transaction) => {
    const params = await readExportParams(tenant, transaction);
    const last = lastRun.get(tenant.companyId) || 0;
    if (!force && now.getTime() - last < params.jobMinutes * 60000) return null;
    const summary = await expireCompany(tenant, transaction, { now });
    lastRun.set(tenant.companyId, now.getTime());
    keys.push(...summary.storageKeys);
    return { expired: summary.expired, timedOut: summary.timedOut };
  }, 'dlp');
  removeFromDisk(keys);
  return result;
}

function startExportExpiryJob({ intervalMs = TICK_MS } = {}) {
  const tick = () => runExportExpiryJob().catch((err) => logger.error({ err: err.message }, 'exportExpiryJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runExportExpiryJob, startExportExpiryJob };
