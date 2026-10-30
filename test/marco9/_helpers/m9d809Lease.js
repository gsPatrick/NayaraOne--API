'use strict';

// Contrato de locação ativo com partes e vistoria de entrada assinada, dentro da transação do teste (rollback), para os testes M9-D809 (não é teste).
const propertiesService = require('../../../src/features/properties/properties.service');
const contractsService = require('../../../src/features/legal/contracts.service');
const inspectionsService = require('../../../src/features/legal/inspections.service');
const peopleService = require('../../../src/features/people/people.service');

const sfx = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

/** { contract, inspection, landlord, tenantPerson }: contrato ACTIVE (ou o status pedido) com término em `endsAt`. */
async function locacaoAtiva(t, transaction, { status = 'ACTIVE', endsAt = null } = {}) {
  const suffix = sfx();
  const property = await propertiesService.createProperty({ groupId: t.groupId, companyId: t.companyId, propertyType: 'RESIDENTIAL', title: `QA-M9 D809 ${suffix}`, internalCode: `M9D809-${suffix}` }, t.userId, transaction);
  const contract = await contractsService.createContract({ groupId: t.groupId, companyId: t.companyId, contractType: 'LEASE', propertyId: property.id, totalValue: 1000, ...(endsAt ? { endsAt } : {}) }, t.userId, transaction);
  contract.status = status;
  if (endsAt) contract.endsAt = endsAt;
  await contract.save({ transaction });
  const person = (papel) => peopleService.createPerson({ groupId: t.groupId, companyId: t.companyId, personType: 'PF', legalName: `QA-M9 ${papel} ${suffix}` }, t.userId, transaction);
  const landlord = await person('Locador');
  const tenantPerson = await person('Locatário');
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, t.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, t.userId, transaction);
  const inspection = await inspectionsService.createInspection({ groupId: t.groupId, companyId: t.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' }, t.userId, transaction);
  await inspectionsService.completeInspection(inspection.id, t.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: `qa-m9-locador-${suffix}` }, t.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: `qa-m9-locatario-${suffix}` }, t.userId, transaction);
  return { contract, inspection, landlord, tenantPerson, property };
}

module.exports = { locacaoAtiva };
