'use strict';

const { withOwnTenantTransaction } = require('../guard.tx');

/** Transação COMMITADA da empresa (GUCs de grupo, empresa e usuário para a RLS): cada passo do pedido de arquivo se confirma sozinho, como o registro do guard. */
const inTenant = (tenant, userId, fn) => withOwnTenantTransaction(tenant, userId, fn);

module.exports = { inTenant };
