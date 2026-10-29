'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../features/core-governance/data-quality/merge.settings');
const { runDetection } = require('../../features/core-governance/data-quality/merge.detection');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');

/**
 * dataQualityMergeDetectionJob (M9-D805 §5) — detecção noturna de cadastros duplicados de Person, Property e Supplier, na hora configurada
 * (`governanca.dados.merge.deteccao_hora`, padrão 03:00 America/Sao_Paulo). Checa a cada 10 minutos e roda uma vez por dia por empresa; o par já
 * na fila (ou decidido como separado/descartado) não volta. Empresa com o módulo Dados mestres desligado é pulada.
 * Desligar no processo: DATA_QUALITY_MERGE_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastRunDay = new Map();

async function runDataQualityMergeDetectionJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('dataQualityMergeDetectionJob', async (tenant, transaction) => {
    const hour = Number(await getSetting(settings.DETECTION_HOUR_KEY, tenant, transaction, settings.MERGE_SETTING_DEFAULTS[settings.DETECTION_HOUR_KEY]));
    const day = dateKeyInZone(now);
    if (!force && (hourInSaoPaulo(now) !== hour || lastRunDay.get(tenant.companyId) === day)) return null;
    const summary = await runDetection(tenant, transaction);
    lastRunDay.set(tenant.companyId, day);
    return summary;
  }, 'data-quality');
}

function startDataQualityMergeDetectionJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runDataQualityMergeDetectionJob().catch((err) => logger.error({ err: err.message }, 'dataQualityMergeDetectionJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runDataQualityMergeDetectionJob, startDataQualityMergeDetectionJob };
