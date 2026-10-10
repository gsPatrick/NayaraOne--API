'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const personContactsService = require('../src/features/people/personContacts.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const AppError = require('../src/utils/AppError');
const { File, TenantSetting } = require('../src/models');

// O tenant de homologação compartilhado tem `legal.signature_provider=clicksign` configurado DE
// VERDADE (token real) para testes manuais de assinatura eletrônica em andamento. O teste
// "fluxo feliz" abaixo testa o GATE de negócio de ativação de contrato, não a integração real
// com o Clicksign — precisa do Sandbox determinístico (sem I/O de rede). Zera explicitamente as
// settings de assinatura DENTRO da própria transação de rollback (hard delete, nunca commitado —
// mesma nota em test/legal.signatureProviders.test.js).
const SIGNATURE_SETTING_KEYS = [
  'legal.signature_provider',
  'legal.clicksign_api_token',
  'legal.clicksign_environment',
  'legal.clicksign_webhook_secret',
  'legal.zapsign_api_token',
  'legal.zapsign_webhook_secret',
];

async function clearSignatureSettings(transaction) {
  await TenantSetting.destroy({
    where: { companyId: tenant.companyId, key: SIGNATURE_SETTING_KEYS },
    transaction,
    force: true,
  });
}

async function createFakeDocumentFile(transaction) {
  const suffix = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `homo-qa/contracts/${suffix}.pdf`,
      fileName: `contrato-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

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
  // O tenant de homologação compartilhado tem `legal.signature_provider=clicksign` configurado
  // DE VERDADE (token real) para testes manuais de assinatura eletrônica em andamento — o
  // provedor real exige e-mail cadastrado por signatário (LEGAL_SIGNATURE_EMAIL_REQUIRED).
  // Dado de teste legítimo, não workaround de bug.
  for (const person of [landlord, tenantPerson]) {
    await personContactsService.createContact(
      person.id,
      { contactType: 'EMAIL', valueNormalized: `qa+${suffix}-${person.id.slice(0, 8)}@nayaraone.dev`, isPrimary: true },
      tenant.userId,
      transaction
    );
  }
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
    const file = await createFakeDocumentFile(transaction);
    await contractVersionsService.createContractVersion(contract.id, { content: 'HOMO QA — corpo do contrato de teste', documentFileId: file.id }, tenant.userId, transaction);
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
    await clearSignatureSettings(transaction);
    const suffix = uniqueSuffix();
    const contract = await createLeaseWithParties(transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    const file = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `HOMO QA — corpo do contrato ${suffix}`, documentFileId: file.id },
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

// FIX DIVERGÊNCIA (auditoria técnica da cliente, 07/10/2026): o teste abaixo afirmava que
// "contrato ACTIVE não tem transição de saída" — isso CONTRADIZ literalmente o Caderno (Anexo I,
// "5. Estado do contrato"), que lista os status SUSPENDED/TERMINATED/CLOSED e define
// ACTIVE -> ['SUSPENDED', 'TERMINATED']. Um contrato locado em vigor PRECISA poder ser suspenso
// (inadimplência em negociação, decisão judicial) e encerrado (rescisão) sem perder histórico.
// O teste antigo travava exatamente o comportamento que o contrato exige — substituído pelos
// testes abaixo, que cobrem a máquina de estados real de fim-de-vida.
test('máquina de estados: ACTIVE -> SUSPENDED (suspendContract) preserva histórico e exige motivo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });

    await assert.rejects(
      () => contractsService.suspendContract(contract.id, '', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_TRANSITION_REASON_REQUIRED');
        return true;
      }
    );

    const suspended = await contractsService.suspendContract(contract.id, 'Inadimplência em negociação.', tenant.userId, transaction);
    assert.equal(suspended.status, 'SUSPENDED');

    // Histórico preservado: é a MESMA linha (nunca apagada/recriada).
    const reloaded = await contractsService.getContract(contract.id, transaction);
    assert.equal(reloaded.id, contract.id);
    assert.equal(reloaded.status, 'SUSPENDED');
  });
});

test('máquina de estados: SUSPENDED -> ACTIVE (reactivateContract)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });
    await contractsService.suspendContract(contract.id, 'Decisão judicial liminar.', tenant.userId, transaction);

    const reactivated = await contractsService.reactivateContract(contract.id, 'Inadimplência regularizada.', tenant.userId, transaction);
    assert.equal(reactivated.status, 'ACTIVE');
  });
});

test('máquina de estados: SUSPENDED -> TERMINATED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });
    await contractsService.suspendContract(contract.id, 'Inadimplência em negociação.', tenant.userId, transaction);

    const terminated = await contractsService.terminateContract(contract.id, 'Rescisão por inadimplência não sanada.', tenant.userId, transaction);
    assert.equal(terminated.status, 'TERMINATED');
  });
});

test('máquina de estados: ACTIVE -> TERMINATED direto (sem passar por SUSPENDED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });

    const terminated = await contractsService.terminateContract(contract.id, 'Rescisão amigável.', tenant.userId, transaction);
    assert.equal(terminated.status, 'TERMINATED');
  });
});

test('máquina de estados: TERMINATED -> CLOSED (closeContract)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });
    await contractsService.terminateContract(contract.id, 'Rescisão amigável.', tenant.userId, transaction);

    const closed = await contractsService.closeContract(contract.id, 'Arquivamento operacional.', tenant.userId, transaction);
    assert.equal(closed.status, 'CLOSED');

    // CLOSED é terminal: nada sai dele (sem renovação, sem ACTIVE->CLOSED direto já coberto
    // abaixo pelo teste de transição inválida).
    assert.deepEqual(contractsService.VALID_TRANSITIONS.CLOSED, []);
  });
});

test('máquina de estados: terminateContract é bloqueado com garantia ACTIVE pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const guaranteesService = require('../src/features/legal/guarantees.service');
    const contract = await createLeaseWithParties(transaction);
    contract.status = 'ACTIVE';
    await contract.save({ transaction });
    const parties = await contractsService.listContractParties(contract.id, transaction);
    const tenantParty = parties.find((p) => p.partyRole === 'TENANT');
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 1000, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );
    void tenantParty;

    await assert.rejects(
      () => contractsService.terminateContract(contract.id, 'Tentativa sem liberar garantia.', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_TERMINATION_GUARANTEE_PENDING');
        return true;
      }
    );
  });
});

test('máquina de estados: transições inválidas são bloqueadas (DRAFT -> ACTIVE direto, SUSPENDED -> CLOSED direto)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseWithParties(transaction);
    // DRAFT -> ACTIVE não existe na máquina de estados.
    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'ACTIVE', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_INVALID_TRANSITION');
        return true;
      }
    );

    contract.status = 'SUSPENDED';
    await contract.save({ transaction });
    // SUSPENDED -> CLOSED não existe (precisa passar por TERMINATED).
    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'CLOSED', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_INVALID_TRANSITION');
        return true;
      }
    );
  });
});
