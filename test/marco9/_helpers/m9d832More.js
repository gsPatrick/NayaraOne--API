'use strict';

// Apoio dos testes M9-D832 (não é teste): lançamento a receber, processo jurídico e processo de financiamento (resultado manual) criados pelos serviços normais. Não é teste.
const env = require('./bcpEnv');
const { person } = require('./m9d832Base');
const { createFinancialEntry } = require('../../../src/features/finance/financialEntries.service');
const legalCasesService = require('../../../src/modules/legal/cases/legal-case.service');
const financingCasesService = require('../../../src/features/correspondent/cases/financingCases.service');
const { FinancingCase } = require('../../../src/models');

/** Lançamento a receber (PENDING) do contrato, em reais (ex.: 1205 = R$ 1.205,00). */
function createReceivable(tenant, base, amount) {
  return env.inTx(tenant, async (tx) => {
    const entry = await createFinancialEntry({
      groupId: tenant.groupId, companyId: tenant.companyId, resultCenterId: base.resultCenter.id, contractId: base.contract.id, entryType: 'CREDIT', nature: 'RECEIVABLE', amount,
      description: 'Aluguel BCP QA', dueAt: new Date(),
    }, tenant.userId, tx);
    return entry.id;
  });
}

function createLegalCase(tenant) {
  return env.inTx(tenant, async (tx) => (await legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', phase: 'INITIAL_PETITION', summary: 'Processo BCP QA' }, tenant.userId, tx
  )).id);
}

/** Processo de financiamento de resultado manual, já enviado ao banco (SUBMITTED), pronto para receber andamento. */
function createFinancingCase(tenant) {
  return env.inTx(tenant, async (tx) => {
    const applicant = await person(tenant, tx, 'BCP Proponente');
    const created = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'manual', applicants: [{ personId: applicant.id, role: 'PRINCIPAL' }] }, tenant.userId, tx
    );
    await FinancingCase.update({ status: 'SUBMITTED' }, { where: { id: created.id }, transaction: tx });
    return created.id;
  });
}

/** Contrato ativo, em imóvel próprio, SEM vistoria de entrada: as chaves não podem ser liberadas por nenhum caminho (a trava do serviço normal recusa). */
function createBareContract(tenant, base) {
  return env.inTx(tenant, async (tx) => {
    const contractsService = require('../../../src/modules/legal/contracts/application/contract.service');
    const property = await require('../../../src/features/properties/properties.service').createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyType: 'RESIDENTIAL', title: `BCP QA sem vistoria ${Date.now()}`, internalCode: `BCPSV-${Date.now()}` }, tenant.userId, tx
    );
    const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', propertyId: property.id, totalValue: 900 }, tenant.userId, tx);
    contract.status = 'ACTIVE';
    await contract.save({ transaction: tx });
    await contractsService.addContractParty(contract.id, { personId: base.lessee.id, partyRole: 'TENANT' }, tenant.userId, tx);
    return contract.id;
  });
}

module.exports = { createBareContract, createReceivable, createLegalCase, createFinancingCase };
