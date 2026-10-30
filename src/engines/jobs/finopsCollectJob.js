'use strict';

const logger = require('../../utils/logger');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runHourly, runDaily } = require('../../features/core-governance/finops/collectors');
const { readFinopsParams } = require('../../features/core-governance/finops/finops.params');

/**
 * finopsCollectJob (M9-D860 §5) — coletores do cost ledger. A cada 10 minutos fecha as horas encerradas de IA, mensageria e egress e importa a fatura se houver
 * fonte; uma vez por dia, na hora configurada (`governanca.finops.storage_hora`, padrão 02:00 de Brasília), mede o armazenamento do dia anterior.
 * Empresa com o módulo FinOps desligado é pulada. Desligar no processo: FINOPS_COLLECT_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastStorageDay = new Map();

async function runFinopsCollectJob(now = new Date(), { force = false, billingSource, measurements } = {}) {
  return runForEachCompany('finopsCollectJob', async (tenant, transaction) => {
    const summary = { hourly: await runHourly(tenant, now, transaction, { billingSource }), daily: [] };
    const params = await readFinopsParams(tenant, transaction);
    const day = dateKeyInZone(now);
    if (force || (hourInSaoPaulo(now) === params.storageHour && lastStorageDay.get(tenant.companyId) !== day)) {
      summary.daily = await runDaily(tenant, now, transaction, { measurements });
      lastStorageDay.set(tenant.companyId, day);
    }
    return summary;
  }, 'finops');
}

function startFinopsCollectJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runFinopsCollectJob().catch((err) => logger.error({ err: err.message }, 'finopsCollectJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runFinopsCollectJob, startFinopsCollectJob };
