'use strict';

/**
 * FIN-002 (contas e cadastros segregados por empresa) — pentest do Marco 4, achado CRÍTICO PT4-0839: a empresa B gravava lançamento na
 * PRÓPRIA empresa apontando para o centro de custo (ou de resultado) da empresa A. A chave estrangeira não passa pela RLS; a checagem é
 * explícita, pela leitura sob a RLS da empresa do contexto: centro de outra empresa não é visível e responde igual a centro inexistente (404),
 * sem oráculo. A comparação é com a empresa do CONTEXTO (a RLS), não com o companyId do corpo: um companyId forjado com centro próprio continua
 * sendo barrado pela política de RLS do INSERT (ADV-F02).
 */
const AppError = require('../../../../utils/AppError');
const entries = require('../../infrastructure/repositories/financial-entry.repository');

async function assertCentersOfCompany({ costCenterId, resultCenterId }, _companyId, transaction) {
  if (costCenterId && !(await entries.findCostCenter(costCenterId, transaction))) {
    throw AppError.notFound('Centro de custo não encontrado.', 'FINANCE_COST_CENTER_NOT_FOUND');
  }
  if (resultCenterId && !(await entries.findResultCenter(resultCenterId, transaction))) {
    throw AppError.notFound('Centro de resultado não encontrado.', 'FINANCE_RESULT_CENTER_NOT_FOUND');
  }
}

module.exports = { assertCentersOfCompany };
