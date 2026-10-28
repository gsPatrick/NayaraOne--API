'use strict';

const { IntegrationConnection } = require('../../models');

/** Conexão do fornecedor de financiamento da empresa (a ativa primeiro); nula se a empresa ainda não cadastrou. */
async function findFinancingConnectionId(providerCode, companyId, transaction) {
  const c = await IntegrationConnection.findOne({
    where: { companyId, providerCode: String(providerCode).toLowerCase() },
    order: [['status', 'ASC'], ['created_at', 'ASC']], attributes: ['id', 'status'], transaction,
  });
  return c ? c.id : null;
}

module.exports = { findFinancingConnectionId };
