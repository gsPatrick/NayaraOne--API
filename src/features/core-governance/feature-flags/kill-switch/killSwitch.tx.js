'use strict';

const { sequelize } = require('../../../../models');

/**
 * Executa `fn(transaction)` numa transação do tenant (RLS). Com `outer` (testes e quem já tem transação) usa a do chamador. Sem ela, abre e CONFIRMA uma transação própria: é assim que
 * o switch acionado pelo drill fica visível a outras conexões enquanto o probe roda, e que o estado gravado antes do efeito sobrevive a uma queda do processo (M9-D872 §3.2).
 */
async function inTenantTransaction(tenant, outer, fn) {
  if (outer) return fn(outer);
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", {
      replacements: { groupId: tenant.groupId, companyId: tenant.companyId }, transaction,
    });
    return fn(transaction);
  });
}

module.exports = { inTenantTransaction };
