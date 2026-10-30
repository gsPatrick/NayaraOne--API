'use strict';

const logger = require('../../utils/logger');
const { runForEachCompany } = require('./calendarJobRunner');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runDegradation, syncProcessEffects } = require('../../features/core-governance/finops/degradation/run');
const { readDegradationParams } = require('../../features/core-governance/finops/degradation/degradation.params');
const { hourInSaoPaulo } = require('../../features/core-governance/finops/degradation/state');
const { JOB_NAME } = require('../../features/core-governance/finops/degradation/degradation.constants');

/**
 * finopsDegradationJob (M9-D863 §3.3): a cada hora, no minuto `governanca.finops.degradacao.minuto_job` (padrão 20), para cada empresa com o FinOps ligado,
 * consome o evento finops.budget.threshold e o consumo atual e aplica NO MÁXIMO UM passo da política por orçamento por execução; desfaz o passo quando o
 * período recomeça ou o consumo volta abaixo do limiar. Só mexe em funções opcionais da aplicação: nenhum caminho aqui desliga recurso de infraestrutura.
 * Ao subir o processo, reaplica ao logger o efeito que vive em memória. Desligar no processo: FINOPS_DEGRADATION_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;
const lastRun = new Map();

const minuteInSaoPaulo = (date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }).format(date));
const slotOf = (now) => `${dateKeyInZone(now)}T${String(hourInSaoPaulo(now)).padStart(2, '0')}`;

/** Esta empresa deve rodar agora? No minuto configurado e uma vez por hora. */
function isDue(tenant, params, now, force) {
  if (force) return true;
  return minuteInSaoPaulo(now) === params.jobMinute && lastRun.get(tenant.companyId) !== slotOf(now);
}

async function runDegradationJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany(JOB_NAME, async (tenant, transaction) => {
    const params = await readDegradationParams(tenant, transaction);
    if (!isDue(tenant, params, now, force)) return null;
    const result = await runDegradation(tenant, transaction, { now });
    lastRun.set(tenant.companyId, slotOf(now));
    return result;
  }, 'finops');
}

/** Na subida: só sincroniza o efeito em memória (nível de log) com o que está aplicado no banco. */
const syncOnBoot = () => runForEachCompany(`${JOB_NAME}.boot`, async (tenant, transaction) => {
  await syncProcessEffects(tenant, await readDegradationParams(tenant, transaction), transaction);
  return null;
}, 'finops');

function startFinopsDegradationJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  syncOnBoot().catch((err) => logger.error({ err: err.message }, 'finopsDegradationJob.boot_failed'));
  const tick = () => runDegradationJob().catch((err) => logger.error({ err: err.message }, 'finopsDegradationJob.failed'));
  return setInterval(tick, intervalMs);
}

module.exports = { runDegradationJob, startFinopsDegradationJob, isDue, minuteInSaoPaulo };
