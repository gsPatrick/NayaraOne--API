'use strict';

const { sequelize } = require('../../../models');

/**
 * Transação PRÓPRIA do guard, com o contexto de tenant/RLS aplicado (M9-D821 §3.2): o registro do pedido e do bloqueio não pode depender da transação do negócio,
 * porque ela é desfeita quando a recusa sobe. Mesma configuração de `req.withTenantTransaction`.
 */
function withOwnTenantTransaction(tenant, actorUserId, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true), set_config('app.user_id', :userId, true)", {
      transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId || '' },
    });
    return fn(transaction);
  });
}

module.exports = { withOwnTenantTransaction };
