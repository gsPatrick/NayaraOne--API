'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runDispatchCycle, readWorkerParams } = require('../../features/integrations/dispatch/worker');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationDispatchWorkerJob (Marco 9, M9-D214): executa os envios a fornecedores pendentes de cada empresa. O relógio acorda a
 * cada TICK_MS; quem decide se a empresa está na hora é `integration.dispatch.worker_interval_s` (padrão 2 s) e o tamanho do
 * lote é `integration.dispatch.worker_batch_size` (padrão 20). Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 1000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { intervalS } = await tenantTx(ctx, (transaction) => readWorkerParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= intervalS * 1000;
}

async function runIntegrationDispatchWorkerJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, claimed: 0, sent: 0, deferred: 0, failed: 0, errors: 0 };
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
        const r = await runDispatchCycle(ctx, { now });
        summary.companies += 1;
        ['claimed', 'sent', 'deferred', 'failed', 'errors'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationDispatchWorkerJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationDispatchWorkerJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationDispatchWorkerJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationDispatchWorkerJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationDispatchWorkerJob, startIntegrationDispatchWorkerJob };
