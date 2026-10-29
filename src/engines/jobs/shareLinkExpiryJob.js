'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../features/core-governance/dlp/share/share.settings');
const { expireCompanyLinks } = require('../../features/core-governance/dlp/share/share.expiry');
const { cleanupCounters } = require('../../features/core-governance/dlp/share/share.ratelimit');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * shareLinkExpiryJob (M9-D823 §2b) — marca como EXPIRED os links externos vencidos (e o pedido SHARE de cada um) e apaga as janelas antigas do contador de acessos públicos.
 * Confere a cada minuto e roda por empresa no intervalo de `governanca.dlp.link.expiracao_job_minutos` (padrão 5). Desligar no processo: DLP_SHARE_EXPIRY_JOB_DISABLED=true.
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function runShareLinkExpiryJob(now = new Date(), { force = false } = {}) {
  const result = await runForEachCompany('shareLinkExpiryJob', async (tenant, transaction) => {
    const minutes = settings.intOr(await getSetting(settings.JOB_MINUTES_KEY, tenant, transaction, settings.SHARE_SETTING_DEFAULTS[settings.JOB_MINUTES_KEY]), settings.JOB_MINUTES_KEY);
    if (!force && now.getTime() - (lastRun.get(tenant.companyId) || 0) < minutes * 60000) return null;
    const summary = await expireCompanyLinks(tenant, transaction);
    lastRun.set(tenant.companyId, now.getTime());
    return summary;
  }, 'dlp');
  await cleanupCounters();
  return result;
}

function startShareLinkExpiryJob({ intervalMs = TICK_MS } = {}) {
  const tick = () => runShareLinkExpiryJob().catch((err) => logger.error({ err: err.message }, 'shareLinkExpiryJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runShareLinkExpiryJob, startShareLinkExpiryJob };
