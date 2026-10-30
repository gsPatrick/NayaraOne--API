'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const { moduleSettingKey } = require('../../features/core-governance/governance.settings');

/**
 * Como `runForEachCompany` (calendarJobRunner), mas SEM abrir uma transação em volta do trabalho: `work(tenant)` abre e confirma as transações que precisar. Serve ao job que
 * precisa de efeito confirmado entre as fases (o kill switch acionado fica visível às outras conexões enquanto o probe roda; M9-D872). Pula a empresa que desligou o módulo;
 * erro de uma empresa é registrado e não derruba as demais.
 */
async function runForEachCompanyDetached(name, work, moduleCode) {
  const total = { companies: 0, ran: 0, errors: 0, summaries: [] };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      const tenant = { groupId: group.id, companyId: company.id };
      try {
        const enabled = await sequelize.transaction(async (transaction) => {
          await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: group.id, companyId: company.id }, transaction });
          return (await getSetting(moduleSettingKey(moduleCode), tenant, transaction, true)) !== false;
        });
        if (!enabled) continue;
        const summary = await work(tenant);
        if (summary) { total.ran += 1; total.summaries.push({ companyId: company.id, ...summary }); }
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, `${name}.company.failed`);
      }
    }
  }
  if (total.ran || total.errors) logger.info({ companies: total.companies, ran: total.ran, errors: total.errors }, `${name}.run`);
  return total;
}

module.exports = { runForEachCompanyDetached };
