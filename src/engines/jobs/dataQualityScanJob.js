'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../features/core-governance/data-quality/quality.settings');
const { scanCompany } = require('../../features/core-governance/data-quality/quality.scan');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');

/**
 * dataQualityScanJob (M9-D806 §5) — varredura noturna da qualidade de cadastro, na hora configurada (`governanca.dados.qualidade.varredura_hora`, padrão
 * 03:00 America/Sao_Paulo). Checa a cada 10 minutos e roda uma vez por dia por empresa: avalia pessoas, imóveis e fornecedores e chama
 * notifyPendingDomains. Empresa com o módulo Dados mestres desligado é pulada. Desligar no processo: DATA_QUALITY_SCAN_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastRunDay = new Map();

async function runDataQualityScanJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('dataQualityScanJob', async (tenant, transaction) => {
    const hour = Number(await getSetting(settings.SCAN_HOUR_KEY, tenant, transaction, settings.QUALITY_SETTING_DEFAULTS[settings.SCAN_HOUR_KEY]));
    const day = dateKeyInZone(now);
    if (!force && (hourInSaoPaulo(now) !== hour || lastRunDay.get(tenant.companyId) === day)) return null;
    const summary = await scanCompany(tenant, transaction, { now });
    lastRunDay.set(tenant.companyId, day);
    return summary;
  }, 'data-quality');
}

function startDataQualityScanJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runDataQualityScanJob().catch((err) => logger.error({ err: err.message }, 'dataQualityScanJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runDataQualityScanJob, startDataQualityScanJob };
