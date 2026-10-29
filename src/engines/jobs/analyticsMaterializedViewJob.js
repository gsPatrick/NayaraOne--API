'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock');
const readModels = require('../../features/analytics/read-models');

/**
 * analyticsMaterializedViewJob (Marco 9, M9-D698 3.2): refresh CONCORRENTE das materialized views do BI (analytics.mv_*), nunca bloqueando a
 * leitura. A agenda vem de `analytics.mv.schedule` de cada empresa (padrão: a cada 6 h e às 00:40 de America/Sao_Paulo); como a view é de todas
 * as empresas, ela é atualizada UMA vez por passada se alguma empresa estiver no horário, com os limites (statement_timeout e lock_timeout) da
 * primeira empresa no horário. Falha de uma view não derruba as demais.
 */
const TICK_MS = 60 * 1000;
const stateByCompany = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: company.id }, transaction });
    return fn(transaction);
  });
}

async function evaluateCompany(group, company, now, force) {
  const scope = { groupId: group.id, companyId: company.id };
  return tenantTx(group, company, async (transaction) => {
    const { schedule } = await readModels.readMvParams(scope, transaction);
    const decision = readModels.scheduleDue(now, schedule, stateByCompany.get(company.id));
    if (!decision.due && !force) return null;
    return { company, schedule, local: decision.local, params: await readModels.readRefreshParams(scope, transaction) };
  });
}

/** Uma passada por todas as empresas. `force` ignora a agenda (teste e execução manual). */
async function runAnalyticsMaterializedViewJob({ now = clock.now(), force = false } = {}) {
  if (force) stateByCompany.clear();
  const summary = { companies: 0, views: 0, rows: 0, errors: 0 };
  const due = [];
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const d = await evaluateCompany(group, company, now, force);
        if (d) due.push(d);
      } catch (err) {
        summary.errors += 1;
        logger.error({ err, companyId: company.id }, '[AnalyticsMaterializedViewJob] falha ao avaliar a agenda da empresa');
      }
    }
  }
  if (!due.length) return summary;
  for (const view of readModels.listMaterializedViews()) {
    try {
      const out = await readModels.refreshMaterializedView(view.name, { now, params: due[0].params });
      summary.views += 1;
      summary.rows += out.rows;
    } catch (err) {
      summary.errors += 1;
      logger.error({ err, view: view.name }, '[AnalyticsMaterializedViewJob] falha no refresh da view');
    }
  }
  for (const d of due) stateByCompany.set(d.company.id, readModels.afterRun(now, d.schedule, d.local));
  summary.companies = due.length;
  return summary;
}

function startAnalyticsMaterializedViewJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsMaterializedViewJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsMaterializedViewJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsMaterializedViewJob, startAnalyticsMaterializedViewJob };
