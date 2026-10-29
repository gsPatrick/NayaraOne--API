'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { readRefreshParams, refreshCompanyScheduled, scheduleDue, afterRun } = require('../../features/analytics/read-models');

/**
 * analyticsReadModelRefreshJob (Marco 9, M9-D607 3.3): recalcula os read models do BI que dependem do relógio (vencimentos 7/30/60,
 * vencidos) e os agregados adiados por passar do teto de linhas. A agenda vem de `analytics.refresh.schedule` de cada empresa
 * (padrão: a cada 15 min e às 00:05 de America/Sao_Paulo). O relógio acorda de minuto em minuto; cada empresa roda quando a agenda manda.
 * Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 60 * 1000;
const stateByCompany = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, now, force, summary) {
  const scope = { groupId: group.id, companyId: company.id };
  const { params, due, local } = await tenantTx(group, company, async (transaction) => {
    const p = await readRefreshParams(scope, transaction);
    return { params: p, ...scheduleDue(now, p.schedule, stateByCompany.get(company.id)) };
  });
  if (!due && !force) return;
  const refreshed = await tenantTx(group, company, (transaction) => refreshCompanyScheduled(scope, params, transaction, { now }));
  stateByCompany.set(company.id, afterRun(now, params.schedule, local));
  summary.companies += 1;
  summary.readModels += refreshed.length;
  summary.rows += refreshed.reduce((acc, r) => acc + (r.rows || 0), 0);
}

/** Uma passada por todas as empresas. `force` ignora a agenda (teste e execução manual). */
async function runAnalyticsReadModelRefreshJob({ now = new Date(), force = false } = {}) {
  if (force) stateByCompany.clear();
  const summary = { companies: 0, readModels: 0, rows: 0, errors: 0 };
  const groups = await Group.findAll();
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        await runCompany(group, company, now, force, summary);
      } catch (err) {
        summary.errors += 1;
        logger.error({ err, companyId: company.id }, '[AnalyticsReadModelRefreshJob] falha na empresa');
      }
    }
  }
  return summary;
}

function startAnalyticsReadModelRefreshJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsReadModelRefreshJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsReadModelRefreshJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsReadModelRefreshJob, startAnalyticsReadModelRefreshJob };
