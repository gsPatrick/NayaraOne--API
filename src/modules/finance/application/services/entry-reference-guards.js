'use strict';

/**
 * FIN-002 (contas e cadastros segregados por empresa) — pentest do Marco 4, achado CRÍTICO PT4-0839: a empresa B gravava lançamento na
 * PRÓPRIA empresa apontando para o centro de custo (ou de resultado) da empresa A. A chave estrangeira não passa pela RLS; a checagem é
 * explícita, pela leitura sob a RLS da empresa do contexto: centro de outra empresa responde igual a centro inexistente (404), sem oráculo.
 */
const AppError = require('../../../../utils/AppError');
const entries = require('../../infrastructure/repositories/financial-entry.repository');

async function assertCentersOfCompany({ costCenterId, resultCenterId }, companyId, transaction) {
  if (costCenterId) {
    const cc = await entries.findCostCenter(costCenterId, transaction);
    if (!cc || cc.companyId !== companyId) throw AppError.notFound('Centro de custo não encontrado.', 'FINANCE_COST_CENTER_NOT_FOUND');
  }
  if (resultCenterId) {
    const rc = await entries.findResultCenter(resultCenterId, transaction);
    if (!rc || rc.companyId !== companyId) throw AppError.notFound('Centro de resultado não encontrado.', 'FINANCE_RESULT_CENTER_NOT_FOUND');
  }
}

module.exports = { assertCentersOfCompany };
