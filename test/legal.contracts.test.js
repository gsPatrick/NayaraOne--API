'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseWithParties(transaction) {
  const suffix = uniqueSuffix();
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locatário ${suffix}` },
    tenant.userId,
    transaction
  );
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  return contract;
}

// Regressão do HOM-001 (homologação 28/08/2026): contrato virava ACTIVE sem nenhuma versão de
// documento nem assinatura. Estes 3 testes travam exatamente o cenário que a cliente reportou.

test('HOM-001: contrato não avança para SIGNING sem nenhuma versão de documento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);

    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_DOCUMENT_GATE');
        return true;
      }
    );
  });
});

test('HOM-001: contrato não avança para SIGNED sem todas as assinaturas confirmadas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    await contractVersionsService.createContractVersion(contract.id, { content: 'HOMO QA — corpo do contrato de teste' }, tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);

    // Tentativa de pular direto pra SIGNED sem nenhuma Signature registrada.
    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'SIGNED', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_SIGNATURE_GATE');
        return true;
      }
    );
  });
});

test('fluxo feliz: documento + todas as assinaturas confirmadas leva o contrato a ACTIVE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `HOMO QA — corpo do contrato ${suffix}` },
      tenant.userId,
      transaction
    );
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);

    const parties = await contractsService.listContractParties(contract.id, transaction);
    const signatures = await signaturesService.initiateSignature(version.id, parties.map((p) => p.personId), tenant.userId, transaction);
    assert.equal(signatures.length, 2, 'uma assinatura solicitada por parte do contrato');

    // Confirma cada assinatura via webhook (idêntico ao fluxo real do provedor) — a última
    // confirmação já transiciona o Contract pai automaticamente pra SIGNED.
    let lastResult;
    for (const signature of signatures) {
      lastResult = await signaturesService.handleSignatureWebhook(signature.externalSignatureId, {}, transaction);
    }
    assert.equal(lastResult.contractTransitioned, true);

    const signedContract = await contractsService.getContract(contract.id, transaction);
    assert.equal(signedContract.status, 'SIGNED');

    const activeContract = await contractsService.transitionContractStatus(signedContract, 'ACTIVE', tenant.userId, transaction);
    assert.equal(activeContract.status, 'ACTIVE');
  });
});

test('máquina de estados: contrato ACTIVE não tem transição de saída (não se cancela pelo fluxo normal)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE'; // simula um contrato já ativo, sem passar pelas etapas
    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'CANCELLED', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_INVALID_TRANSITION');
        return true;
      }
    );
  });
});
