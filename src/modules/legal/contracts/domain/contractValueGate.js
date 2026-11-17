'use strict';

const AppError = require('../../../../utils/AppError');
const { LINKED_CONTRACT_TYPES } = require('./contractTypes');

/**
 * Porta do valor na aprovação do contrato (DI-BI2-5). O Caderno M5 não trata do valor do contrato; a regra é a mesma
 * que a tela de criação já aplica (lista/novo/page.js: contrato principal só com valor > 0):
 *  - contrato principal (fora de LINKED_CONTRACT_TYPES) só passa de LEGAL_REVIEW para APPROVED com totalValue > 0;
 *  - aditivo e termos de entrega (vinculados ao principal) aprovam sem valor.
 * De APPROVED em diante o valor fica congelado (TERMS_LOCKED_STATUSES em contract.service.js), por isso a porta é aqui.
 */
function hasPositiveValue(totalValue) {
  if (totalValue === null || totalValue === undefined || totalValue === '') return false;
  const n = Number(totalValue);
  return Number.isFinite(n) && n > 0;
}

function assertContractValueForApproval(contract) {
  if (LINKED_CONTRACT_TYPES.includes(contract.contractType)) return;
  if (hasPositiveValue(contract.totalValue)) return;
  throw AppError.unprocessable(
    'Informe o valor do contrato (maior que zero) antes de aprovar: o contrato principal não é aprovado sem valor.',
    'LEGAL_CONTRACT_TOTAL_VALUE_REQUIRED',
    { field: 'totalValue' }
  );
}

module.exports = { assertContractValueForApproval, hasPositiveValue };
