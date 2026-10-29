'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock');
const { inCompany } = require('../../features/analytics/companyTx');
const alerts = require('../../features/analytics/alerts');
const { onRefreshed } = require('../../features/analytics/read-models/readModel.refreshed');

/**
 * analyticsAlertEvaluationJob (Marco 9, M9-D691 3.1): a cada `analytics.alert.intervalo_avaliacao_min` (padrão 5 min, por empresa) e logo depois de
 * cada refresh de read model, avalia as definições de alerta PUBLISHED da empresa (alert engine). O relógio acorda de minuto em minuto; cada empresa roda
 * quando o intervalo dela venceu. Falha de uma empresa não derruba as demais. Nunca executa ação financeira.
 */
const TICK_MS = 60 * 1000;
const lastRunByCompany = new Map();
const inFlight = new Set();

async function intervalOf(group, company) {
  const scope = { groupId: group.id, companyId: company.id };
  return inCompany(scope, async (tx) => (await alerts.readAlertParams(scope, tx)).intervalMinutes);
}

async function runCompany(group, company, now, force, summary) {
  const last = lastRunByCompany.get(company.id);
  if (!force && last && now.getTime() - last < (await intervalOf(group, company)) * 60000) return;
  lastRunByCompany.set(company.id, now.getTime());
  const out = await alerts.evaluateCompanyAlerts({ groupId: group.id, companyId: company.id }, { now });
  summary.companies += 1;
  summary.evaluated += out.results.length;
  summary.opened += out.results.filter((r) => r.action === 'OPENED').length;
  summary.failed += out.failed.length;
}

/** Uma passada por todas as empresas. `force` ignora o intervalo (teste e execução manual). */
async function runAnalyticsAlertEvaluationJob({ now = clock.now(), force = false } = {}) {
  if (force) lastRunByCompany.clear();
  const summary = { companies: 0, evaluated: 0, opened: 0, failed: 0, errors: 0 };
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
        logger.error({ err, companyId: company.id }, '[AnalyticsAlertEvaluationJob] falha na empresa');
      }
    }
  }
  return summary;
}

/** Avaliação logo depois do refresh de um read model da empresa (uma de cada vez por empresa; refreshes que chegam durante a avaliação são cobertos por ela ou pelo próximo ciclo). */
async function evaluateAfterRefresh({ companyId, groupId }, { now = clock.now() } = {}) {
  if (inFlight.has(companyId)) return null;
  inFlight.add(companyId);
  try {
    return await alerts.evaluateCompanyAlerts({ companyId, groupId }, { now });
  } finally {
    inFlight.delete(companyId);
  }
}

function startAnalyticsAlertEvaluationJob({ tickMs = TICK_MS } = {}) {
  onRefreshed((payload) => {
    evaluateAfterRefresh(payload).catch((err) => logger.error({ err, companyId: payload.companyId }, '[AnalyticsAlertEvaluationJob] falha na avaliação após o refresh'));
  });
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsAlertEvaluationJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsAlertEvaluationJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsAlertEvaluationJob, evaluateAfterRefresh, startAnalyticsAlertEvaluationJob };
