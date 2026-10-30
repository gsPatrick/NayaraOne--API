'use strict';

const { forEachCompany, startLoop } = require('./automationJobCore');

/**
 * automationRunnerJob (M9-D414) — o tick de agenda do runner, a cada minuto: cada fluxo ACTIVE com gatilho SCHEDULE cuja expressão cron casa com o minuto gera o evento
 * sintético `sched:{fluxo}:{janela}` e passa pelos mesmos 9 passos. O consumo dos eventos do outbox não precisa de job próprio: o runner é consumidor registrado do
 * outbox-dispatcher (automations/runner/runner.consumer.js).
 */
const INTERVAL_MS = 60 * 1000;

async function runAutomationRunnerJob(now = new Date()) {
  const { runner } = require('../../features/marketing/automations');
  return forEachCompany('automationRunnerJob', async (tenant, transaction) => {
    const tick = await runner.runScheduleTick(tenant, transaction, { now });
    return { created: tick.created };
  });
}

const startAutomationRunnerJob = ({ intervalMs = INTERVAL_MS } = {}) => startLoop('automationRunnerJob', () => runAutomationRunnerJob(), intervalMs);

module.exports = { runAutomationRunnerJob, startAutomationRunnerJob, INTERVAL_MS };
