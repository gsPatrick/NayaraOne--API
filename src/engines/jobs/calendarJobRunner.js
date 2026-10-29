'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const { moduleSettingKey } = require('../../features/core-governance/governance.settings');

/**
 * Percorre grupos e empresas abrindo uma transação por empresa com o contexto de tenant (RLS), pulando as que desligaram o módulo
 * Calendário. `work(tenant, transaction)` devolve o resumo da empresa (ou null quando não houve trabalho). Erro de uma empresa é
 * registrado e não derruba as demais. Usado pelos jobs de alerta do calendário (vencido e conflito).
 */
async function runForEachCompany(name, work) {
  const total = { companies: 0, ran: 0, errors: 0, summaries: [] };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      try {
        const summary = await sequelize.transaction(async (transaction) => {
          await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", {
            replacements: { groupId: group.id, companyId: company.id }, transaction,
          });
          const tenant = { groupId: group.id, companyId: company.id };
          if ((await getSetting(moduleSettingKey('calendar'), tenant, transaction, true)) === false) return null;
          return work(tenant, transaction);
        });
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

module.exports = { runForEachCompany };
