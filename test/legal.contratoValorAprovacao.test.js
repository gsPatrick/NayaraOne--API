'use strict';

/**
 * Porta do valor na aprovação do contrato (DI-BI2-5; contractValueGate.js). Antes o contrato principal chegava a
 * APPROVED sem valor (e dali em diante o valor fica congelado, TERMS_LOCKED_STATUSES). Agora LEGAL_REVIEW -> APPROVED
 * exige totalValue > 0 no contrato principal; aditivo e termos de entrega (vinculados) aprovam sem valor.
 * Postgres real com RLS, tudo em transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, waiveAllContractRequirements } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const contractVersionsService = require('../src/modules/legal/contracts/application/contractVersions.service');
const { hasPositiveValue } = require('../src/modules/legal/contracts/domain/contractValueGate');
const { Contract, File } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const recusaValor = (err) => {
  assert.equal(err.code, 'LEGAL_CONTRACT_TOTAL_VALUE_REQUIRED');
  assert.equal(err.statusCode, 422);
  return true;
};

async function arquivo(t) {
  const sfx = uniqueSuffix();
  return File.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `valor/${sfx}.pdf`, fileName: `contrato-${sfx}.pdf`, mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
}

async function criar(t, payload) {
  return contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, ...payload }, tenant.userId, t);
}

async function comPartes(contract, t) {
  for (const partyRole of ['LANDLORD', 'TENANT']) {
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Parte valor ${partyRole} ${uniqueSuffix()}` }, tenant.userId, t);
    await contractsService.addContractParty(contract.id, { personId: person.id, partyRole }, tenant.userId, t);
  }
}

/** Leva até LEGAL_REVIEW, com checklist dispensado e versão de documento. */
async function emRevisao(contract, t) {
  await waiveAllContractRequirements(contract.id, tenant.userId, t);
  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, t);
  const file = await arquivo(t);
  await contractVersionsService.createContractVersion(contract.id, { content: `Corpo do contrato ${uniqueSuffix()}`, documentFileId: file.id }, tenant.userId, t);
  await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, t);
  return contract;
}

test('DI-BI2-5: contrato principal sem valor (ou com valor 0) não é aprovado (422); com valor > 0 aprova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await criar(t, { contractType: 'LEASE_RESIDENTIAL' });
    assert.equal(contract.totalValue, null, 'nasce sem valor');
    await comPartes(contract, t);
    await emRevisao(contract, t);

    await assert.rejects(contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, t), recusaValor);
    assert.equal((await Contract.findByPk(contract.id, { transaction: t })).status, 'LEGAL_REVIEW', 'continua em revisão');

    await contractsService.correctContractData(contract.id, { totalValue: 0, reason: 'Valor zerado para o teste' }, tenant.userId, t);
    await contract.reload({ transaction: t });
    await assert.rejects(contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, t), recusaValor);

    await contractsService.correctContractData(contract.id, { totalValue: 2500, reason: 'Valor do contrato informado' }, tenant.userId, t);
    await contract.reload({ transaction: t });
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, t);
    assert.equal((await Contract.findByPk(contract.id, { transaction: t })).status, 'APPROVED');
  });
});

test('DI-BI2-5: aditivo vinculado ao principal aprova sem valor', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const principal = await criar(t, { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
    const aditivo = await criar(t, { contractType: 'ADDENDUM', parentContractId: principal.id });
    assert.equal(aditivo.totalValue, null);
    await emRevisao(aditivo, t);
    await contractsService.transitionContractStatus(aditivo, 'APPROVED', tenant.userId, t);
    assert.equal((await Contract.findByPk(aditivo.id, { transaction: t })).status, 'APPROVED');
  });
});

test('DI-BI2-5: regra do valor (pura)', () => {
  for (const sem of [null, undefined, '', 0, '0', '0.00', -1, 'abc']) assert.equal(hasPositiveValue(sem), false, String(sem));
  for (const com of [0.01, '1500.00', 1]) assert.equal(hasPositiveValue(com), true, String(com));
});
