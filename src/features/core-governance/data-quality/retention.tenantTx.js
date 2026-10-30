'use strict';

const { sequelize } = require('../../../models');

/** Abre uma transação NOVA com o contexto de tenant (RLS) da empresa; usada por quem precisa de várias transações independentes (lotes do apply, job). */
function openTenantTx(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
    if (tenant.userId) await sequelize.query("SELECT set_config('app.user_id', :userId, true)", { replacements: { userId: tenant.userId }, transaction });
    return fn(transaction);
  });
}

module.exports = { openTenantTx };
