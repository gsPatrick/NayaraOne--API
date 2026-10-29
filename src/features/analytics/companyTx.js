'use strict';

/**
 * M9-D609 — transação COMMITADA no contexto de uma empresa (GUCs de grupo e empresa) com o escritor do BI ligado. É o que os jobs do BI
 * (snapshot diário M9-D609, alert engine M9-D691) usam para gravar uma unidade de trabalho por transação, de modo que a falha de uma não
 * desfaz as outras.
 */
const { sequelize } = require('../../models');
const { enableAnalyticsWriter } = require('./metricStore.service');

async function inCompany(scope, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: scope.groupId, c: scope.companyId }, transaction });
    await enableAnalyticsWriter(transaction);
    return fn(transaction);
  });
}

module.exports = { inCompany };
