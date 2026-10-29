'use strict';

const { registerEventConsumer } = require('../../../engines/events/consumers');
const repo = require('./tracking.events.repository');
const { recordSale } = require('./tracking.sale.service');

/**
 * M9-D431 regra 5: o contrato de VENDA ativado (contract.activated) registra a venda na atribuição. Só contrato de venda com
 * oportunidade; locação, administração e serviço não são "venda". Idempotente: o evento SALE é único por oportunidade.
 */
const SALE_CONTRACT_TYPES = Object.freeze(['SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS']);
const CONSUMER = 'marketing.tracking.sale_attribution';

async function onContractActivated(event, transaction) {
  const contractId = event.aggregateId;
  const contract = await repo.findContractForSale(contractId, transaction);
  if (!contract || !contract.opportunity_id || !SALE_CONTRACT_TYPES.includes(contract.contract_type)) return { skipped: true };
  return recordSale({
    tenant: { groupId: event.groupId, companyId: event.companyId }, actor: null, opportunityId: contract.opportunity_id,
    contractId, contractValue: contract.total_value === null ? 0 : contract.total_value,
  }, transaction);
}

registerEventConsumer('contract.activated', CONSUMER, onContractActivated);

module.exports = { CONSUMER, SALE_CONTRACT_TYPES, onContractActivated };
