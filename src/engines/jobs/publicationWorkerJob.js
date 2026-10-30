'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { startLoop } = require('./automationJobCore');

/**
 * publicationWorkerJob (M9-D411) — worker de publicação do Marketing. O relógio do job bate a cada TICK_MS (constante do job) e cada empresa roda o seu ciclo a cada
 * `marketing.worker.intervalo_s` (parâmetro da empresa, lido no ciclo; padrão 30). Duas instâncias do processo não pegam o mesmo job: o worker seleciona com FOR UPDATE SKIP LOCKED
 * e grava RUNNING antes de falar com o canal. Cada etapa do ciclo abre a sua própria transação da empresa (mesma configuração de RLS dos outros jobs do Marketing).
 */
const TICK_MS = 5 * 1000;
const nextRunAt = new Map();

const inCompanyTx = (tenant) => (work) => sequelize.transaction(async (transaction) => {
  await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
  return work(transaction);
});

async function runPublicationWorkerJob(now = new Date()) {
  const { runWorkerCycle } = require('../../features/marketing/publications/worker');
  const total = { companies: 0, due: 0, errors: 0, summaries: [] };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      if ((nextRunAt.get(company.id) || 0) > now.getTime()) continue;
      total.due += 1;
      const tenant = { groupId: group.id, companyId: company.id };
      try {
        const summary = await runWorkerCycle(tenant, { withTx: inCompanyTx(tenant), now });
        nextRunAt.set(company.id, now.getTime() + summary.intervalS * 1000);
        if (summary.claimed || summary.reconciled || summary.recovered || summary.metrics || summary.errors) total.summaries.push({ companyId: company.id, ...summary });
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'publicationWorkerJob.company.failed');
      }
    }
  }
  if (total.summaries.length || total.errors) logger.info({ companies: total.companies, due: total.due, errors: total.errors }, 'publicationWorkerJob.run');
  return total;
}

const startPublicationWorkerJob = ({ tickMs = TICK_MS } = {}) => startLoop('publicationWorkerJob', () => runPublicationWorkerJob(), tickMs);

module.exports = { runPublicationWorkerJob, startPublicationWorkerJob, TICK_MS };
