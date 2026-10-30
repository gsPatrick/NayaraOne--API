'use strict';

const logger = require('../../utils/logger');
const { runForEachCompany } = require('./calendarJobRunner');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runExpiry } = require('../../features/core-governance/feature-flags/expiry.service');
const { readFlagsParams } = require('../../features/core-governance/feature-flags/flags.params');

/**
 * featureFlagExpiryJob (M9-D871 §3.2): uma vez por dia, a partir de `governanca.flags.expiracao_hora`:`governanca.flags.expiracao_minuto` (padrão 06:30 de Brasília), para cada
 * empresa com o módulo de feature flags ligado, passa as flags temporárias vencidas a EXPIRED e avisa o responsável (notificação CRÍTICA, uma por flag e por dia). Rodar de
 * novo no mesmo dia não duplica nada (estado e reserva do alerta). Desligar no processo: FEATURE_FLAG_EXPIRY_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;
const lastRun = new Map();

function minutesOfDayInSaoPaulo(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

/** Esta empresa deve rodar agora? Passado o horário configurado e ainda não rodou hoje (um atraso do processo não perde o dia). */
function isDue(tenant, params, now, force) {
  if (force) return true;
  return minutesOfDayInSaoPaulo(now) >= params.expiryHour * 60 + params.expiryMinute && lastRun.get(tenant.companyId) !== dateKeyInZone(now);
}

async function runFeatureFlagExpiryJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('featureFlagExpiryJob', async (tenant, transaction) => {
    const params = await readFlagsParams(tenant, transaction);
    if (!isDue(tenant, params, now, force)) return null;
    const result = await runExpiry(tenant, transaction, { now });
    lastRun.set(tenant.companyId, dateKeyInZone(now));
    return result;
  }, 'feature-flags');
}

function startFeatureFlagExpiryJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runFeatureFlagExpiryJob().catch((err) => logger.error({ err: err.message }, 'featureFlagExpiryJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runFeatureFlagExpiryJob, startFeatureFlagExpiryJob, isDue, minutesOfDayInSaoPaulo };
