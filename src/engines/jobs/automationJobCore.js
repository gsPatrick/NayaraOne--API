'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');

/**
 * Percorre grupos e empresas abrindo, para CADA empresa, a mesma transação com SET LOCAL app.group_id/app.company_id do tenant.middleware.js (fail-closed, igual aos
 * outros jobs do Marketing). `work(tenant, transaction)` devolve um resumo; erro de uma empresa é registrado e não derruba as demais.
 */
async function forEachCompany(name, work) {
  const total = { companies: 0, errors: 0, summaries: [] };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      try {
        const summary = await sequelize.transaction(async (transaction) => {
          await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: group.id, companyId: company.id }, transaction });
          return work({ groupId: group.id, companyId: company.id }, transaction);
        });
        if (summary) total.summaries.push({ companyId: company.id, ...summary });
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, `${name}.company.failed`);
      }
    }
  }
  if (total.errors || total.summaries.some((s) => Object.values(s).some((v) => typeof v === 'number' && v > 0))) logger.info({ companies: total.companies, errors: total.errors }, `${name}.run`);
  return total;
}

const startLoop = (name, run, intervalMs) => {
  const tick = () => run().catch((err) => logger.error({ err: err.message }, `${name}.failed`));
  tick();
  return setInterval(tick, intervalMs);
};

module.exports = { forEachCompany, startLoop };
