'use strict';

const logger = require('../../utils/logger');
const { runForEachCompanyDetached } = require('./detachedCompanyRunner');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runCycle } = require('../../features/core-governance/feature-flags/kill-switch/killSwitch.cycle');
const { inTenantTransaction } = require('../../features/core-governance/feature-flags/kill-switch/killSwitch.tx');
const { readFlagsParams } = require('../../features/core-governance/feature-flags/flags.params');
const { minutesOfDayInSaoPaulo } = require('./featureFlagExpiryJob');

/**
 * killSwitchDrillJob (M9-D872 §3.2): uma vez por dia, a partir de `governanca.flags.kill_teste_hora`:`governanca.flags.kill_teste_minuto` (padrão 05:00 de Brasília), para cada empresa
 * com o módulo de feature flags ligado: restaura o teste que ficou pela metade, testa em HOMOLOG/DEV os kill switches vencidos (periodicidade `governanca.flags.kill_teste_dias`) ou
 * UNVERIFIED (reexecuta todo dia até PASS) e alerta o responsável do que está sem PASS válido. Em PROD nunca testa. Cada fase do teste é confirmada em separado (killSwitch.tx).
 * Desligar no processo: KILL_SWITCH_DRILL_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;
const lastRun = new Map();

/** Esta empresa deve rodar agora? Passado o horário configurado e ainda não rodou hoje. */
function isDue(tenant, params, now, force) {
  if (force) return true;
  return minutesOfDayInSaoPaulo(now) >= params.killHour * 60 + params.killMinute && lastRun.get(tenant.companyId) !== dateKeyInZone(now);
}

async function runKillSwitchDrillJob(now = new Date(), { force = false, environment } = {}) {
  return runForEachCompanyDetached('killSwitchDrillJob', async (tenant) => {
    const params = await inTenantTransaction(tenant, null, (tx) => readFlagsParams(tenant, tx));
    if (!isDue(tenant, params, now, force)) return null;
    const result = await runCycle(tenant, { now, environment });
    lastRun.set(tenant.companyId, dateKeyInZone(now));
    return result;
  }, 'feature-flags');
}

function startKillSwitchDrillJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runKillSwitchDrillJob().catch((err) => logger.error({ err: err.message }, 'killSwitchDrillJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runKillSwitchDrillJob, startKillSwitchDrillJob, isDue };
