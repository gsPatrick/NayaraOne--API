'use strict';

const logger = require('../../utils/logger');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runDetector } = require('../../features/core-governance/finops/detectors/run');
const { DETECTORS } = require('../../features/core-governance/finops/detectors');
const { readDetectorParams } = require('../../features/core-governance/finops/detectors/detectors.params');

/**
 * Jobs dos detectores de desperdício do FinOps (M9-D862 §5): CINCO jobs, um por detector, cada um com a sua rodada própria (`runForEachCompany` com nome distinto).
 * Os quatro diários (storage órfão, logs, modelo de IA caro e egress) rodam uma vez por dia, na hora `governanca.finops.detectores_hora` (padrão 03:00 de Brasília);
 * o de fila acumulada roda a cada `governanca.finops.fila_intervalo_min` minutos (padrão 5). Empresa com o FinOps desligado é pulada. Nenhum detector altera dado
 * de negócio. Desligar no processo: FINOPS_DETECTORS_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;
const lastRun = new Map();

/** Esta empresa deve rodar este detector agora? Diário: na hora configurada e uma vez por dia; fila: passado o intervalo desde a última execução. */
function isDue(detector, tenant, params, now, force) {
  if (force) return true;
  const key = `${detector.detector}:${tenant.companyId}`;
  const last = lastRun.get(key);
  if (detector.schedule === 'queue') return !last || now.getTime() - last.at >= params.queueInterval * 60000;
  return hourInSaoPaulo(now) === params.detectorHour && (!last || last.day !== dateKeyInZone(now));
}

async function runDetectorJob(detector, now = new Date(), { force = false } = {}) {
  return runForEachCompany(`finopsDetector.${detector.detector}`, async (tenant, transaction) => {
    const params = await readDetectorParams(tenant, transaction);
    if (!isDue(detector, tenant, params, now, force)) return null;
    const result = await runDetector(tenant, detector, now, transaction);
    lastRun.set(`${detector.detector}:${tenant.companyId}`, { at: now.getTime(), day: dateKeyInZone(now) });
    return result;
  }, 'finops');
}

/** Roda os cinco jobs de uma vez (usado pelo agendador e pelos testes). */
const runAllDetectorJobs = (now = new Date(), opts = {}) => Promise.all(DETECTORS.map((d) => runDetectorJob(d, now, opts)));

function startFinopsDetectorsJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const timers = DETECTORS.map((detector) => {
    const tick = () => runDetectorJob(detector).catch((err) => logger.error({ detector: detector.detector, err: err.message }, 'finopsDetectorsJob.failed'));
    tick();
    return setInterval(tick, intervalMs);
  });
  return timers;
}

module.exports = { runDetectorJob, runAllDetectorJobs, startFinopsDetectorsJob, isDue };
