'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock');
const { readRefreshParams, refreshCompanyScheduled } = require('../../features/analytics/read-models');
const { OWN_CADENCE } = require('../../features/analytics/read-models/tecnologia/common');
const { readTechParams } = require('../../features/analytics/read-models/tecnologia.settings');

/**
 * analyticsTechRefreshJob (Marco 9, DI-BI-3): recalcula os read models de Tecnologia e IA (disponibilidade, filas, freshness, integrações, bloqueios, falhas de autenticação,
 * custo, qualidade e chamadas de ferramenta da IA) a cada `analytics.tec.recalculo_min` de cada empresa (padrão 4), fora da agenda geral do BI (analytics.refresh.schedule,
 * padrão 15 min). Sem isto, os indicadores técnicos, que valem por 5 minutos (M9-D680: "job a cada 5 min"), passavam a maior parte do tempo como desatualizados ou expirados
 * entre duas passadas da agenda geral. Cada empresa tem o seu relógio; o relógio do job acorda a cada 15 s. Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 15 * 1000;
const lastRunByCompany = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, force, summary) {
  const scope = { groupId: group.id, companyId: company.id };
  const now = clock.now(); // o instante da fonte é o do início da passada DESTA empresa
  const { refresh, minutes } = await tenantTx(group, company, async (transaction) => ({
    refresh: await readRefreshParams(scope, transaction), minutes: (await readTechParams(scope, transaction)).refreshMinutes,
  }));
  const last = lastRunByCompany.get(company.id);
  if (!force && last && now.getTime() - last < minutes * 60000) return;
  lastRunByCompany.set(company.id, now.getTime());
  const refreshed = await tenantTx(group, company, (transaction) => refreshCompanyScheduled(scope, refresh, transaction, { now, cadence: OWN_CADENCE }));
  summary.companies += 1;
  summary.readModels += refreshed.length;
  summary.failed += refreshed.filter((r) => r.failed).length;
}

/** Uma passada por todas as empresas. `force` ignora o intervalo (teste e execução manual). */
async function runAnalyticsTechRefreshJob({ force = false } = {}) {
  const summary = { companies: 0, readModels: 0, failed: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        await runCompany(group, company, force, summary);
      } catch (err) {
        summary.errors += 1;
        logger.error({ err, companyId: company.id }, '[AnalyticsTechRefreshJob] falha na empresa');
      }
    }
  }
  return summary;
}

function startAnalyticsTechRefreshJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsTechRefreshJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsTechRefreshJob] falha na execução agendada');
    });
  }, tickMs);
}

/** Só para teste: esquece quando cada empresa rodou. */
const resetAnalyticsTechRefreshState = () => lastRunByCompany.clear();

module.exports = { runAnalyticsTechRefreshJob, startAnalyticsTechRefreshJob, resetAnalyticsTechRefreshState };
