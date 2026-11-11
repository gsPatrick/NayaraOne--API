'use strict';

// Correção da verificação independente do Marco 5 (linhas 131, 134 e 135 da matriz; Caderno §18, Guia §15):
// cada status que o livro associa a um evento publica o evento por QUALQUER caminho que leve a ele, e
// contract.version.approved só sai com uma versão de fato aprovada. Serviço real, transação desfeita no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const contractVersionsService = require('../src/modules/legal/contracts/application/contractVersions.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const signaturesService = require('../src/modules/legal/signatures/signature.service');
const { File, TenantSetting, OutboxEvent, ContractVersion } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const eventos = (type, contractId, t) => OutboxEvent.findAll({ where: { eventType: type, aggregateId: contractId }, order: [['created_at', 'ASC']], transaction: t });

async function contratoAtivo(t) {
  const c = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 }, tenant.userId, t);
  c.status = 'ACTIVE';
  await c.save({ transaction: t });
  return c;
}

async function arquivo(t) {
  const s = uniqueSuffix();
  return File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `m5ct/${s}.pdf`, fileName: `c-${s}.pdf`, mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
}

/** Locação com partes, checklist dispensado e versão 1, levada até SIGNING pela aprovação real da versão. */
async function contratoEmAssinatura(t) {
  await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: ['legal.signature_provider', 'legal.clicksign_api_token', 'legal.zapsign_api_token'] }, transaction: t, force: true });
  const s = uniqueSuffix();
  const c = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 }, tenant.userId, t);
  for (const [role, nome] of [['LANDLORD', 'Locador'], ['TENANT', 'Locatário']]) {
    const p = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5CT ${nome} ${s}` }, tenant.userId, t);
    await contractsService.addContractParty(c.id, { personId: p.id, partyRole: role }, tenant.userId, t);
  }
  await requirementsService.generateRequirementsForContract(c.id, {}, tenant.userId, t);
  for (const r of await requirementsService.listRequirements(c.id, t)) {
    await requirementsService.satisfyRequirement(r.id, { waivedReason: 'Fora do escopo do teste de eventos' }, tenant.userId, t);
  }
  const v1 = await contractVersionsService.createContractVersion(c.id, { content: `M5CT eventos v1 ${s}`, documentFileId: (await arquivo(t)).id }, tenant.userId, t);
  await contractsService.transitionContractStatus(c, 'DOCUMENTS_PENDING', tenant.userId, t);
  await contractsService.transitionContractStatus(c, 'LEGAL_REVIEW', tenant.userId, t);
  await contractsService.transitionContractStatus(c, 'APPROVED', tenant.userId, t);
  await contractsService.transitionContractStatus(c, 'SIGNING', tenant.userId, t);
  return { c, v1 };
}

test('§18 linha 134: reativar o contrato suspenso publica contract.activated (mesmo evento do /transition)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await contratoAtivo(t);
    await contractsService.suspendContract(c.id, 'Suspensão para o teste', tenant.userId, t);
    assert.equal((await eventos('contract.activated', c.id, t)).length, 0);
    const reativado = await contractsService.reactivateContract(c.id, 'Causa sanada', tenant.userId, t);
    assert.equal(reativado.status, 'ACTIVE');
    const evs = await eventos('contract.activated', c.id, t);
    assert.equal(evs.length, 1, 'a reativação dedicada precisa publicar contract.activated');
    assert.equal(evs[0].payloadJson.id, c.id);
  });
});

test('§18 linha 135: encerrar pela transição genérica (/transition) publica contract.terminated, de ACTIVE e de SUSPENDED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ativo = await contratoAtivo(t);
    await contractsService.transitionContractStatus(ativo, 'TERMINATED', tenant.userId, t);
    assert.equal((await contractsService.getContract(ativo.id, t)).status, 'TERMINATED');
    assert.equal((await eventos('contract.terminated', ativo.id, t)).length, 1, 'ACTIVE -> TERMINATED pelo /transition');

    const suspenso = await contratoAtivo(t);
    await contractsService.transitionContractStatus(suspenso, 'SUSPENDED', tenant.userId, t);
    await contractsService.transitionContractStatus(suspenso, 'TERMINATED', tenant.userId, t);
    assert.equal((await eventos('contract.terminated', suspenso.id, t)).length, 1, 'SUSPENDED -> TERMINATED pelo /transition');

    // E o caminho dedicado continua publicando uma vez só.
    const dedicado = await contratoAtivo(t);
    await contractsService.terminateContract(dedicado.id, 'Rescisão', tenant.userId, t);
    assert.equal((await eventos('contract.terminated', dedicado.id, t)).length, 1);
  });
});

test('§18 linha 131: contract.version.approved só com versão aprovada — voltar de SIGNING para APPROVED (versão nova ou /transition) não publica', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { c, v1 } = await contratoEmAssinatura(t);
    let evs = await eventos('contract.version.approved', c.id, t);
    assert.equal(evs.length, 1, 'a aprovação real (LEGAL_REVIEW -> APPROVED) publica uma vez');
    assert.equal(evs[0].payloadJson.contractVersionId, v1.id);
    assert.equal((await ContractVersion.findByPk(v1.id, { transaction: t })).status, 'APPROVED');

    // /transition SIGNING -> APPROVED não aprova nada.
    await contractsService.transitionContractStatus(c, 'APPROVED', tenant.userId, t);
    assert.equal((await eventos('contract.version.approved', c.id, t)).length, 1, 'SIGNING -> APPROVED pelo /transition não é aprovação');

    // Versão nova com o contrato em SIGNING: o contrato volta a APPROVED com a versão nova em DRAFT.
    await contractsService.transitionContractStatus(c, 'SIGNING', tenant.userId, t);
    const v2 = await contractVersionsService.createContractVersion(c.id, { content: `M5CT eventos v2 ${uniqueSuffix()}`, documentFileId: (await arquivo(t)).id }, tenant.userId, t);
    assert.equal((await contractsService.getContract(c.id, t)).status, 'APPROVED');
    assert.equal((await ContractVersion.findByPk(v2.id, { transaction: t })).status, 'DRAFT');
    evs = await eventos('contract.version.approved', c.id, t);
    assert.equal(evs.length, 1, 'versão em DRAFT nunca sai como aprovada');
    for (const e of evs) {
      const v = await ContractVersion.findByPk(e.payloadJson.contractVersionId, { transaction: t });
      assert.notEqual(v.id, v2.id);
      assert.equal(e.payloadJson.contentHash, v.contentHash);
    }
  });
});

test('§18: cada status com evento do livro publica o evento pela transição genérica (APPROVED, SIGNING, SIGNED, ACTIVE, TERMINATED)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { c, v1 } = await contratoEmAssinatura(t);
    assert.equal((await eventos('contract.sent_for_signature', c.id, t)).length, 1);
    const parties = await contractsService.listContractParties(c.id, t);
    for (const s of await signaturesService.initiateSignature(v1.id, parties.map((p) => p.personId), tenant.userId, t)) {
      await signaturesService.handleSignatureWebhook(s.externalSignatureId, {}, t);
    }
    assert.equal((await contractsService.getContract(c.id, t)).status, 'SIGNED');
    assert.equal((await eventos('contract.signed', c.id, t)).length, 1);
    const assinado = await contractsService.getContract(c.id, t);
    await contractsService.transitionContractStatus(assinado, 'ACTIVE', tenant.userId, t);
    assert.equal((await eventos('contract.activated', c.id, t)).length, 1);
    await contractsService.suspendContract(c.id, 'teste', tenant.userId, t);
    await contractsService.reactivateContract(c.id, 'teste', tenant.userId, t);
    assert.equal((await eventos('contract.activated', c.id, t)).length, 2, 'a reativação é uma nova ocorrência de contract.activated');
    await contractsService.suspendContract(c.id, 'teste', tenant.userId, t);
    await contractsService.transitionContractStatus(await contractsService.getContract(c.id, t), 'ACTIVE', tenant.userId, t);
    assert.equal((await eventos('contract.activated', c.id, t)).length, 3, 'SUSPENDED -> ACTIVE pelo /transition também publica');
    await contractsService.terminateContract(c.id, 'teste', tenant.userId, t);
    assert.equal((await eventos('contract.terminated', c.id, t)).length, 1);
  });
});
