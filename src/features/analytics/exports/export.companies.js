'use strict';

/**
 * M9-D701 — percorre todas as empresas (grupo a grupo, como os demais jobs do BI) chamando `fn({ groupId, companyId })`; a falha de uma empresa vai
 * para o log e não impede as outras. Devolve quantas falharam.
 */
const { sequelize, Group, Company } = require('../../../models');
const logger = require('../../../utils/logger');

async function forEachCompany(label, fn) {
  let failures = 0;
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        await fn({ groupId: group.id, companyId: company.id });
      } catch (err) {
        failures += 1;
        logger.error({ err, companyId: company.id }, `[${label}] falha na empresa`);
      }
    }
  }
  return failures;
}

module.exports = { forEachCompany };
