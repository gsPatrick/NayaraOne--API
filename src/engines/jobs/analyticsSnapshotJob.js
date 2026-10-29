'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock');
const { runDailySnapshots } = require('../../features/analytics/metrics/snapshots.service');
require('../../features/analytics/metrics/kpis'); // registra os provedores de snapshot dos KPIs (finance-kpis)

/**
 * analyticsSnapshotJob (Marco 9, M9-D609 3.3): todo dia, a partir de `analytics.snapshot.hora_execucao` (padrão 00:30 de São Paulo), fotografa os
 * KPIs PUBLISHED de cada empresa para a data-base D-1 (e, em catch-up, para os dias que o job perdeu, com captured_late = true). O relógio acorda
 * de minuto em minuto; a empresa já concluída no dia não é reprocessada, e o dia PARTIAL (uma métrica falhou) é refeito depois de RETRY_MS.
 * Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const stateByCompany = new Map();

const finished = (days) => days.every((d) => !d.claimed || d.status === 'COMPLETED');

async function runCompany(group, company, now, force, summary) {
  const today = clock.businessToday(now);
  const state = stateByCompany.get(company.id);
  if (!force && state && state.date === today && (state.done || now.getTime() - state.at < RETRY_MS)) return;
  const result = await runDailySnapshots({ groupId: group.id, companyId: company.id }, { now, ignoreSchedule: force });
  if (!result.ran) return;
  stateByCompany.set(company.id, { date: today, at: now.getTime(), done: finished(result.days) });
  summary.companies += 1;
  summary.days += result.days.filter((d) => d.claimed).length;
  summary.snapshots += result.days.reduce((acc, d) => acc + (d.counts ? d.counts.written : 0), 0);
}

/** Uma passada por todas as empresas. `force` ignora a hora e a memória do dia (teste e execução manual). */
async function runAnalyticsSnapshotJob({ now = clock.now(), force = false } = {}) {
  if (force) stateByCompany.clear();
  const summary = { companies: 0, days: 0, snapshots: 0, errors: 0 };
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
        logger.error({ err, companyId: company.id }, '[AnalyticsSnapshotJob] falha na empresa');
      }
    }
  }
  return summary;
}

function startAnalyticsSnapshotJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsSnapshotJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsSnapshotJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsSnapshotJob, startAnalyticsSnapshotJob };
