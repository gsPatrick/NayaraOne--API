'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runHealthCheckCycle, readHealthParams } = require('../../features/integrations/health');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationHealthCheckJob (Marco 9, M9-D223): a cada `integration.health.check_interval_s` (padrão 60 s, por empresa) pergunta
 * ativamente a cada fornecedor com connection ACTIVE se ele está bem, grava o resultado em provider_health e, depois de
 * `integration.health.down_after_failures` falhas seguidas, marca DOWN e abre o alerta HIGH PROVIDER_DOWN. O relógio acorda de
 * TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela. Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 5000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { checkIntervalS } = await tenantTx(ctx, (transaction) => readHealthParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= checkIntervalS * 1000;
}

async function runIntegrationHealthCheckJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, checked: 0, ok: 0, failed: 0, skipped: 0, errors: 0 };
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
        const r = await runHealthCheckCycle(ctx, { now });
        summary.companies += 1;
        ['checked', 'ok', 'failed', 'skipped'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationHealthCheckJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationHealthCheckJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationHealthCheckJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationHealthCheckJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationHealthCheckJob, startIntegrationHealthCheckJob, resetHealthCheckSchedule: () => lastRun.clear() };
