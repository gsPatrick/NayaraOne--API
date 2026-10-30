'use strict';

const { forEachCompany, startLoop } = require('./automationJobCore');

/**
 * automationDueJob (M9-D414) — a cada 60 s (constante do job, não parâmetro), o executor das ações adiadas: runs WAITING com `next_due_at` vencido. Reavalia o canSend
 * inteiro, envia com a mesma action_key, reagenda ou pula com o motivo, e fecha a run (COMPLETED ou BLOCKED) uma única vez. Também retoma, só nas ações que faltam,
 * a run STARTED parada há mais de `marketing.runner.timeout_s`; run WAITING nunca é tratada como travada.
 */
const INTERVAL_MS = 60 * 1000;

async function runAutomationDueJob(now = new Date()) {
  const { runner } = require('../../features/marketing/automations');
  return forEachCompany('automationDueJob', async (tenant, transaction) => {
    const due = await runner.runDueActions(tenant, transaction, { now });
    const stuck = await runner.recoverStuckRuns(tenant, transaction, { now });
    return { processed: due.processed, replayed: stuck.replayed };
  });
}

const startAutomationDueJob = ({ intervalMs = INTERVAL_MS } = {}) => startLoop('automationDueJob', () => runAutomationDueJob(), intervalMs);

module.exports = { runAutomationDueJob, startAutomationDueJob, INTERVAL_MS };
