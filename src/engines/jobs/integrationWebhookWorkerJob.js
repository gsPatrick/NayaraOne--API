'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runIntakeCycle } = require('../../features/integrations/webhooks/worker');
const { readIntakeParams } = require('../../features/integrations/webhooks/intake/intake.params');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationWebhookWorkerJob (Marco 9, M9-D212): converte os eventos recebidos de cada empresa em eventos internos. O relógio acorda a cada TICK_MS; quem decide se a
 * empresa está na hora é `integration.webhook.worker_interval_s` (padrão 5 s) e o lote é `integration.webhook.worker_batch_size` (padrão 50). Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 1000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { workerIntervalS } = await tenantTx(ctx, (transaction) => readIntakeParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= workerIntervalS * 1000;
}

async function runIntegrationWebhookWorkerJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, claimed: 0, processed: 0, notApplied: 0, deadLettered: 0, failed: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      const ctx = { groupId: group.id, companyId: company.id };
      try {
        if (!(await isDue(ctx, now))) continue;
        lastRun.set(company.id, now.getTime());
        const r = await runIntakeCycle(ctx);
        summary.companies += 1;
        ['claimed', 'processed', 'notApplied', 'deadLettered', 'failed'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationWebhookWorkerJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationWebhookWorkerJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationWebhookWorkerJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationWebhookWorkerJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationWebhookWorkerJob, startIntegrationWebhookWorkerJob };
