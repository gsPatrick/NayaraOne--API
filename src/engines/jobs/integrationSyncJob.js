'use strict';

const { sequelize, Group, Company } = require('../../models');
const { syncListingStatuses, readPortalParams } = require('../../features/integrations/portal');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * integrationSyncJob (Marco 9, M9-D232 3.4): a cada `integration.portal.reconcile_interval_min` (15) lê no portal o status de cada anúncio (fluxo portal.listing_status,
 * cursor retomável) e atualiza o vínculo; mudança externa (o portal reprovou) gera `properties.portal_listing.status_changed`. O relógio acorda de TICK_MS em TICK_MS;
 * quem decide se a empresa está na hora é o parâmetro.
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { reconcileIntervalMin } = await tenantTx(ctx, (transaction) => readPortalParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= reconcileIntervalMin * 60 * 1000;
}

async function runIntegrationSyncJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, checked: 0, changed: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        if (!(await isDue({ groupId: group.id, companyId: company.id }, now))) continue;
        lastRun.set(company.id, now.getTime());
        const r = await syncListingStatuses({ group, company });
        summary.companies += 1;
        summary.checked += r.checked;
        summary.changed += r.changed;
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationSyncJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationSyncJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationSyncJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationSyncJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationSyncJob, startIntegrationSyncJob, resetSyncSchedule: () => lastRun.clear() };
