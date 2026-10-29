'use strict';

const { sequelize } = require('../../../../models');

/** Transação própria com o contexto de empresa da RLS (o middleware e os jobs não têm `req.withTenantTransaction`). */
const inTenantTx = (tenant, fn) => sequelize.transaction(async (transaction) => {
  await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
  return fn(transaction);
});

module.exports = { inTenantTx };
