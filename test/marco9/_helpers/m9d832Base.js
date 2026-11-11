'use strict';

// Apoio dos testes M9-D832 (não é teste): entidades de negócio criadas de verdade (commit) pelos serviços normais, em banco descartável — imóvel, pessoas com CPF válido,
// contrato ativo com vistoria de entrada assinada, centros, obra.
const env = require('./bcpEnv');
const { uniqueCpf } = require('./exportsEnv');
const { uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('../../testHelpers');
const peopleService = require('../../../src/features/people/people.service');
const propertiesService = require('../../../src/features/properties/properties.service');
const contractsService = require('../../../src/features/legal/contracts.service');
const inspectionsService = require('../../../src/features/legal/inspections.service');
const projectsService = require('../../../src/features/construction/projects.service');

async function person(tenant, tx, label, cpf = uniqueCpf()) {
  const created = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `${label} ${uniqueSuffix()}`, taxIdNormalized: cpf }, tenant.userId, tx);
  return { id: created.id, name: created.legalName, cpf };
}

/** Cria, numa transação confirmada, o conjunto base de uma empresa: imóvel, locador e locatário, contrato ativo com vistoria assinada, centro de custo e de resultado, obra. */
function createBase(tenant) {
  return env.inTx(tenant, async (tx) => {
    const suffix = uniqueSuffix();
    const common = { groupId: tenant.groupId, companyId: tenant.companyId };
    const property = await propertiesService.createProperty({ ...common, propertyType: 'RESIDENTIAL', title: `BCP QA ${suffix}`, internalCode: `BCPQA-${suffix}` }, tenant.userId, tx);
    const contract = await contractsService.createContract({ ...common, contractType: 'LEASE', propertyId: property.id, totalValue: 1000 }, tenant.userId, tx);
    contract.status = 'ACTIVE';
    await contract.save({ transaction: tx });
    const landlord = await person(tenant, tx, 'BCP Locador');
    const lessee = await person(tenant, tx, 'BCP Locatário');
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, tx);
    await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, tx);
    const inspection = await inspectionsService.createInspection({ ...common, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' }, tenant.userId, tx);
    await inspectionsService.completeInspection(inspection.id, tenant.userId, tx);
    await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'bcp-qa-locador' }, tenant.userId, tx);
    await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'bcp-qa-locatario' }, tenant.userId, tx);
    // Fechamento M5 (Caderno §10): a entrega de chaves exige o checklist da etapa KEY_DELIVERY cumprido.
    await require('../../testHelpers').waiveAllContractRequirements(contract.id, tenant.userId, tx);
    const costCenter = await createTestCostCenter(tenant, tx, suffix);
    const resultCenter = await createTestResultCenter(tenant, tx, suffix);
    const project = await projectsService.createProject({ ...common, name: `Obra BCP ${suffix}`, code: `OBRA-${suffix}` }, tenant.userId, tx);
    return {
      property: { id: property.id, code: property.internalCode }, contract: { id: contract.id, number: contract.contractNumber }, landlord, lessee,
      costCenter: { id: costCenter.id, code: costCenter.code }, resultCenter: { id: resultCenter.id }, project: { id: project.id, code: project.code },
    };
  });
}

module.exports = { createBase, person };
