'use strict';

const { sequelize, Group, Company } = require('../../models');
const { runCompanyAggregation, readHealthParams } = require('../../features/integrations/health');

/**
 * integrationHealthAggregateJob (Marco 9, M9-D206): a cada `integration.health.aggregate_interval_s` (padrão 60 s,
 * por empresa) grava as janelas de saúde e a linha atual de cada connection ACTIVE. O expurgo das janelas vencidas é do
 * integrationRetentionJob, que chama integration.purge_expired() (M9-D244: o runtime não tem DELETE). Falha de uma empresa ou connection não derruba as demais.
 * O relógio interno acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela.
 */
const TICK_MS = 15000;
const lastRun = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, now) {
  const ctx = { groupId: group.id, companyId: company.id };
  const due = await tenantTx(group, company, async (transaction) => {
    const { aggregateIntervalS } = await readHealthParams(ctx, transaction);
    const last = lastRun.get(company.id);
    return !last || now.getTime() - last >= aggregateIntervalS * 1000;
  });
  if (!due) return null;
  lastRun.set(company.id, now.getTime());
  return tenantTx(group, company, (transaction) => runCompanyAggregation(ctx, { now }, transaction));
}

async function runIntegrationHealthAggregateJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, processed: 0, failed: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const r = await runCompany(group, company, now);
        if (r) {
          summary.companies += 1;
          summary.processed += r.processed;
          summary.failed += r.failed;
        }
      } catch (err) {
        summary.errors += 1;
        console.error(`[IntegrationHealthAggregateJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startIntegrationHealthAggregateJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runIntegrationHealthAggregateJob().finally(() => { running = false; }).catch((err) => {
      console.error('[IntegrationHealthAggregateJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runIntegrationHealthAggregateJob, startIntegrationHealthAggregateJob };
