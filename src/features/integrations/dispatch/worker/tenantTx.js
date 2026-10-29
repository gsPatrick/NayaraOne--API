'use strict';

const { sequelize } = require('../../../../models');

/** Transação no contexto da empresa (RLS por app.group_id e app.company_id), para os workers de envio. */
async function tenantTx(ctx, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: ctx.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: ctx.companyId }, transaction });
    return fn(transaction);
  });
}

module.exports = { tenantTx };
