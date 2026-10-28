'use strict';

const { sequelize } = require('../../../models');

/** Transação curta no contexto da empresa (RLS): cada etapa do ciclo comita sozinha, para o lease e o cursor valerem para os outros workers. */
async function tenantTx(ctx, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: ctx.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: ctx.companyId }, transaction });
    if (ctx.userId) await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: ctx.userId }, transaction });
    return fn(transaction);
  });
}

module.exports = { tenantTx };
