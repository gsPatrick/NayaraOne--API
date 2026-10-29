'use strict';

const { sequelize, Group, Company } = require('../../models');
const { recoverStaleSending, readReconcileParams } = require('../../features/integrations/dispatch/reconcile');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationDispatchOrphanJob (Marco 9, M9-D215 3.4): a cada `integration.dispatch.orphan_interval_s` (padrão 60 s, por empresa) recupera
 * os envios presos em SENDING há mais de `integration.dispatch.sending_stale_s` (padrão 120 s): operação perigosa vai a UNKNOWN e a
 * reconciliação decide; operação segura volta a RETRY_WAIT com backoff. Sem ele, uma queda deixaria a ordem presa.
 */
const TICK_MS = 5000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { orphanIntervalS } = await tenantTx(ctx, (transaction) => readReconcileParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= orphanIntervalS * 1000;
}

async function runIntegrationDispatchOrphanJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, recovered: 0, errors: 0 };
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
        const recovered = await tenantTx(ctx, (transaction) => recoverStaleSending(ctx, transaction, { now }));
        summary.companies += 1;
        summary.recovered += recovered.length;
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationDispatchOrphanJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationDispatchOrphanJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationDispatchOrphanJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationDispatchOrphanJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationDispatchOrphanJob, startIntegrationDispatchOrphanJob, resetOrphanSchedule: () => lastRun.clear() };
