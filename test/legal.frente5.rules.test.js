'use strict';

// Frente 5 (Marco 5 — Regras do Jurídico, conferência 18/10/2026 itens 8, 9, 11, 15):
//  - gate ÚNICO de encerramento: uma pendência de cada tipo bloqueia; cada caminho que encerra
//    (terminate, close, transição genérica, closeout financeiro) passa pelo MESMO gate;
//  - checklist documental para TODOS os tipos; tipo sem modelo bloqueia (falha fechado);
//  - entrega de chaves: política de fotos e termo definidos pelo servidor;
//  - vistoria: atomicidade (falha no meio não deixa lixo) e versão (concorrência otimista).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const models = require('../src/models');
const contractsService = require('../src/features/legal/contracts.service');
const requirementsService = require('../src/features/legal/requirements.service');
const closeoutService = require('../src/features/billing/closeout.service');
const closureGate = require('../src/features/legal/contractClosureGate');
const inspectionsService = require('../src/features/legal/inspections.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');

const { Contract, Person, ContractParty, Property } = models;

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function base() {
  return { groupId: tenant.groupId, companyId: tenant.companyId };
}

async function makeContract(transaction, { status = 'ACTIVE', contractType = 'LEASE' } = {}) {
  return Contract.create(
    { ...base(), contractType, contractNumber: `F5-${uniqueSuffix()}`, status, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

async function makePerson(transaction, name) {
  return Person.create({ ...base(), personType: 'PF', legalName: `${name} ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction });
}

// Uma fábrica por pendência — cada uma cria só a pendência que o nome diz.
const PENDENCY_FACTORIES = {
  async OPEN_BILLING(contract, t) {
    await models.BillingSchedule.create(
      { ...base(), contractId: contract.id, period: '2026-09', dueDate: '2026-09-10', totalAmount: 1000, balance: 1000, generatedAt: new Date(), status: 'OPEN' },
      { transaction: t }
    );
  },
  async OPEN_COLLECTION_CASE(contract, t) {
    // Competência já paga (não conta como OPEN_BILLING), mas o caso de cobrança segue aberto.
    const schedule = await models.BillingSchedule.create(
      { ...base(), contractId: contract.id, period: '2026-08', dueDate: '2026-08-10', totalAmount: 1000, balance: 0, generatedAt: new Date(), status: 'PAID' },
      { transaction: t }
    );
    await models.CollectionCase.create(
      { ...base(), contractId: contract.id, billingScheduleId: schedule.id, status: 'OPEN', overdueSince: '2026-08-11', originalDebtAmount: 1000, currentBalance: 1000 },
      { transaction: t }
    );
  },
  async PENDING_UTILITY_TRANSFER(contract, t) {
    const obligation = await models.UtilityObligation.create(
      { ...base(), contractId: contract.id, utilityType: 'WATER', responsibleParty: 'TENANT' },
      { transaction: t }
    );
    await models.OwnershipTransferTask.create({ ...base(), utilityObligationId: obligation.id, status: 'PENDING' }, { transaction: t });
  },
  async ACTIVE_GUARANTEE(contract, t) {
    await models.Guarantee.create({ ...base(), contractId: contract.id, guaranteeType: 'INSURANCE', status: 'ACTIVE', value: 1000 }, { transaction: t });
  },
  async DEPOSIT_BALANCE(contract, t) {
    const holder = await makePerson(t, 'F5 Titular caução');
    await ContractParty.create({ ...base(), contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }, { transaction: t });
    await models.FinancialEntry.create(
      {
        ...base(),
        contractId: contract.id,
        entryType: 'RECEIVABLE',
        nature: 'RECEIVABLE',
        amount: 3000,
        status: 'SETTLED',
        description: 'Caução F5',
        isThirdPartyFunds: true,
        thirdPartyReference: `Caução contrato ${contract.contractNumber}`,
        thirdPartyHolderPersonId: holder.id,
        createdBy: tenant.userId,
      },
      { transaction: t }
    );
  },
  async OPEN_LEGAL_CASE(contract, t) {
    await models.LegalCase.create({ ...base(), contractId: contract.id, caseType: 'LITIGATION', status: 'OPEN' }, { transaction: t });
  },
  async OPEN_LEGAL_DEADLINE(contract, t) {
    // Processo já CLOSED (não conta como OPEN_LEGAL_CASE), mas com prazo esquecido aberto.
    const legalCase = await models.LegalCase.create({ ...base(), contractId: contract.id, caseType: 'LITIGATION', status: 'CLOSED' }, { transaction: t });
    await models.LegalDeadline.create(
      { ...base(), legalCaseId: legalCase.id, description: 'Prazo F5', dueAt: new Date(Date.now() + 86400000), status: 'PENDING' },
      { transaction: t }
    );
  },
  async OPEN_NOTICE(contract, t) {
    await models.Notice.create({ ...base(), contractId: contract.id, channel: 'EMAIL', content: 'Notificação F5', status: 'SENT' }, { transaction: t });
  },
};

async function expectClosureBlocked(promise, expectedType) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'LEGAL_CONTRACT_CLOSURE_BLOCKED', `código inesperado: ${err.code} ${err.message}`);
    const types = (err.details && err.details.pendencies ? err.details.pendencies : []).map((p) => p.type);
    assert.ok(types.includes(expectedType), `esperava ${expectedType} em ${types.join(',')}`);
    return true;
  });
}

// ---------- 1) Gate único: uma pendência de cada tipo bloqueia o encerramento ----------
for (const [type, factory] of Object.entries(PENDENCY_FACTORIES)) {
  test(`gate único: pendência ${type} bloqueia terminateContract`, async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const contract = await makeContract(t);
      assert.deepEqual(await closureGate.collectContractClosurePendencies(contract.id, t), [], 'contrato limpo não pode ter pendência');
      await factory(contract, t);
      const pendencies = await closureGate.collectContractClosurePendencies(contract.id, t);
      assert.deepEqual(pendencies.map((p) => p.type), [type], 'a fábrica deve gerar exatamente uma pendência');
      await expectClosureBlocked(contractsService.terminateContract(contract.id, 'Teste F5', tenant.userId, t), type);
      const reloaded = await Contract.findByPk(contract.id, { transaction: t });
      assert.equal(reloaded.status, 'ACTIVE');
    });
  });
}

// ---------- 2) Gate único: TODOS os caminhos passam por ele ----------
// Usa uma pendência "jurídica" (notificação) e uma "financeira" (cobrança) — antes o closeout não
// via a jurídica e o terminate/close/transição não viam a financeira.
const PATHS = {
  terminate: { from: 'ACTIVE', run: (c, t) => contractsService.terminateContract(c.id, 'F5', tenant.userId, t) },
  close: { from: 'TERMINATED', run: (c, t) => contractsService.closeContract(c.id, 'F5', tenant.userId, t) },
  'transition ACTIVE->TERMINATED': { from: 'ACTIVE', run: (c, t) => contractsService.transitionContractStatus(c, 'TERMINATED', tenant.userId, t), waive: true },
  'transition TERMINATED->CLOSED': { from: 'TERMINATED', run: (c, t) => contractsService.transitionContractStatus(c, 'CLOSED', tenant.userId, t), waive: true },
  'closeout financeiro': { from: 'ACTIVE', run: (c, t) => closeoutService.closeoutContract(c.id, tenant.userId, t), closeout: true },
};

async function waiveChecklist(contract, t) {
  await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
  for (const r of await requirementsService.listRequirements(contract.id, t)) {
    if (r.status === 'PENDING') await requirementsService.satisfyRequirement(r.id, { waivedReason: 'F5 fora de escopo' }, tenant.userId, t);
  }
}

for (const [pathName, path] of Object.entries(PATHS)) {
  for (const type of ['OPEN_NOTICE', 'OPEN_BILLING', 'DEPOSIT_BALANCE', 'OPEN_LEGAL_DEADLINE']) {
    test(`caminho "${pathName}" bloqueia com ${type}`, async () => {
      await withRollbackTenantTransaction(tenant, async (t) => {
        const contract = await makeContract(t, { status: path.from });
        if (path.waive) await waiveChecklist(contract, t);
        await PENDENCY_FACTORIES[type](contract, t);
        if (path.closeout) {
          await assert.rejects(path.run(contract, t), (err) => {
            assert.equal(err.code, 'CLOSEOUT_BLOCKED');
            assert.ok(err.details.reasons.map((r) => r.type).includes(type));
            return true;
          });
        } else {
          await expectClosureBlocked(path.run(contract, t), type);
        }
        const reloaded = await Contract.findByPk(contract.id, { transaction: t });
        assert.equal(reloaded.status, path.from);
      });
    });
  }

  test(`caminho "${pathName}" encerra quando não há pendência`, async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const contract = await makeContract(t, { status: path.from });
      if (path.waive) await waiveChecklist(contract, t);
      await path.run(contract, t);
      const reloaded = await Contract.findByPk(contract.id, { transaction: t });
      assert.ok(['TERMINATED', 'CLOSED'].includes(reloaded.status), `status final ${reloaded.status}`);
    });
  });
}

test('caução totalmente devolvida não bloqueia; saldo parcial bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await makeContract(t);
    await PENDENCY_FACTORIES.DEPOSIT_BALANCE(contract, t);
    const origin = await models.FinancialEntry.findOne({ where: { contractId: contract.id, isThirdPartyFunds: true }, transaction: t });
    const release = async (amount) =>
      models.FinancialEntry.create(
        {
          ...base(), contractId: contract.id, entryType: 'PAYABLE', nature: 'PAYABLE', amount, status: 'PENDING', description: 'Devolução F5',
          isThirdPartyFunds: true, thirdPartyReference: origin.thirdPartyReference, thirdPartyOriginEntryId: origin.id,
          thirdPartyHolderPersonId: origin.thirdPartyHolderPersonId, createdBy: tenant.userId,
        },
        { transaction: t }
      );
    await release(1000);
    let types = (await closureGate.collectContractClosurePendencies(contract.id, t)).map((p) => p.type);
    assert.deepEqual(types, ['DEPOSIT_BALANCE']);
    await release(2000);
    types = (await closureGate.collectContractClosurePendencies(contract.id, t)).map((p) => p.type);
    assert.deepEqual(types, []);
  });
});

test('closeout usa a MESMA função do gate (checkCloseoutEligibility == collectContractClosurePendencies)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await makeContract(t);
    for (const factory of Object.values(PENDENCY_FACTORIES)) await factory(contract, t);
    const a = await closeoutService.checkCloseoutEligibility(contract.id, t);
    const b = await closureGate.collectContractClosurePendencies(contract.id, t);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((p) => p.type).sort(), Object.keys(PENDENCY_FACTORIES).sort());
  });
});

// ---------- 3) Checklist documental para TODOS os tipos ----------
for (const contractType of contractsService.CONTRACT_TYPES) {
  test(`checklist documental: ${contractType} não avança com zero documentos`, async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const contract = await makeContract(t, { status: 'DRAFT', contractType });
      await assert.rejects(
        contractsService.transitionContractStatus(contract, 'CANCELLED', tenant.userId, t),
        (err) => err.code === 'LEGAL_REQUIREMENTS_PENDING'
      );
      const reqs = await requirementsService.listRequirements(contract.id, t);
      assert.ok(reqs.length > 0, `checklist de ${contractType} não pode ser vazio`);
    });
  });
}

test('checklist documental: tipo SEM modelo bloqueia (falha fechado)', async () => {
  const templates = requirementsService.REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE;
  const saved = templates.SERVICE;
  delete templates.SERVICE;
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const contract = await makeContract(t, { status: 'DRAFT', contractType: 'SERVICE' });
      await assert.rejects(
        contractsService.transitionContractStatus(contract, 'CANCELLED', tenant.userId, t),
        (err) => err.code === 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND'
      );
    });
  } finally {
    templates.SERVICE = saved;
  }
});

// ---------- 4) Entrega de chaves: política e termo do servidor ----------
async function releasableKeyDelivery(t, { contractType = 'LEASE', termType = null } = {}) {
  const property = await Property.create(
    { ...base(), propertyType: 'RESIDENTIAL', title: `F5 KD ${uniqueSuffix()}`, internalCode: `F5KD-${uniqueSuffix()}`, createdBy: tenant.userId },
    { transaction: t }
  );
  const contract = await Contract.create(
    { ...base(), contractType, propertyId: property.id, contractNumber: `F5KD-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId },
    { transaction: t }
  );
  const landlord = await makePerson(t, 'F5 Locador');
  const renter = await makePerson(t, 'F5 Locatário');
  await ContractParty.create({ ...base(), contractId: contract.id, personId: landlord.id, partyRole: 'LANDLORD' }, { transaction: t });
  await ContractParty.create({ ...base(), contractId: contract.id, personId: renter.id, partyRole: 'TENANT' }, { transaction: t });
  const inspection = await inspectionsService.createInspection(
    { ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
    tenant.userId,
    t
  );
  await inspectionsService.completeInspection(inspection.id, tenant.userId, t);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'f5-l' }, tenant.userId, t);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'f5-t' }, tenant.userId, t);
  const kd = await keyDeliveriesService.createKeyDelivery(
    { ...base(), contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: renter.id, termType },
    tenant.userId,
    t
  );
  return { kd, renter, landlord, contract };
}

test('entrega de chaves: cliente não pode mandar política/termo (400)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { kd, renter } = await releasableKeyDelivery(t);
    for (const field of ['photosRequired', 'termText', 'photoPolicy']) {
      await assert.rejects(
        keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, termSignedByPersonId: renter.id, [field]: field === 'photosRequired' ? false : 'x' }, tenant.userId, t),
        (err) => err.code === 'LEGAL_KEY_DELIVERY_SERVER_POLICY'
      );
    }
  });
});

test('entrega de chaves: imóvel usado exige fotos pela política do servidor (cliente não consegue desligar)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { kd, renter } = await releasableKeyDelivery(t, { termType: 'USED_PROPERTY_DELIVERY' });
    await assert.rejects(
      keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, termSignedByPersonId: renter.id }, tenant.userId, t),
      (err) => err.code === 'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'
    );
  });
});

test('entrega de chaves: termo gerado pelo servidor com versão e hash; signatário precisa ser parte/recebedor', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { kd, renter } = await releasableKeyDelivery(t);
    const outsider = await makePerson(t, 'F5 Estranho');
    await assert.rejects(
      keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, termSignedByPersonId: outsider.id }, tenant.userId, t),
      (err) => err.code === 'LEGAL_KEY_DELIVERY_TERM_SIGNER_INVALID'
    );
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 2, keysIdentification: '2 chaves portão', termSignedByPersonId: renter.id }, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.termVersion, keyDeliveriesService.KEY_DELIVERY_TERM_VERSION);
    assert.equal(released.photoPolicy, 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED');
    assert.equal(released.photosRequired, false);
    assert.match(released.termText, /TERMO DE ENTREGA DE CHAVES/);
    assert.match(released.termText, /2 chaves portão/);
    const crypto = require('crypto');
    assert.equal(released.termHash, crypto.createHash('sha256').update(released.termText, 'utf8').digest('hex'));
  });
});

test('entrega de chaves: política do servidor por tipo', () => {
  const p = keyDeliveriesService.resolveKeyDeliveryPhotoPolicy;
  assert.equal(p({ contractType: 'LEASE' }, { termType: null }).photosRequired, false);
  assert.equal(p({ contractType: 'LEASE' }, { termType: 'USED_PROPERTY_DELIVERY' }).photosRequired, true);
  assert.equal(p({ contractType: 'SALE_CASH' }, { termType: 'KEY_DELIVERY' }).photosRequired, true);
});

// ---------- 5) Vistoria: atomicidade e versão ----------
test('vistoria: falha no meio de createInspectionWithItems não deixa vistoria nem itens', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const property = await Property.create(
      { ...base(), propertyType: 'RESIDENTIAL', title: `F5 VI ${uniqueSuffix()}`, internalCode: `F5VI-${uniqueSuffix()}`, createdBy: tenant.userId },
      { transaction: t }
    );
    const tag = uniqueSuffix();
    const names = [`F5 Sala ${tag}`, `F5 Cozinha ${tag}`, `F5 Banheiro ${tag}`];
    const auditBefore = await models.AuditLog.count({ where: { entityType: ['Inspection', 'InspectionItem'] }, transaction: t });
    // Savepoint = o que o withTenantTransaction do request faz com a transação inteira.
    await assert.rejects(
      sequelize.transaction({ transaction: t }, (sp) =>
        inspectionsService.createInspectionWithItems(
          {
            ...base(), propertyId: property.id, inspectionType: 'CHECK_IN',
            items: [
              { itemName: names[0], condition: 'GOOD' },
              { itemName: names[1], condition: 'GOOD' },
              { itemName: names[2], condition: 'DAMAGED' }, // sem damageDescription -> inválido
            ],
          },
          tenant.userId,
          sp
        )
      ),
      (err) => err.code === 'LEGAL_INSPECTION_ITEM_VALIDATION' || /damage/i.test(String(err.code) + err.message)
    );
    assert.equal(await models.Inspection.count({ where: { propertyId: property.id }, transaction: t }), 0, 'vistoria parcial ficou gravada');
    assert.equal(await models.InspectionItem.count({ where: { itemName: names }, transaction: t }), 0, 'itens parciais ficaram gravados');
    const auditAfter = await models.AuditLog.count({ where: { entityType: ['Inspection', 'InspectionItem'] }, transaction: t });
    assert.equal(auditAfter, auditBefore, 'auditoria da vistoria parcial ficou gravada');

    // Controle: o mesmo payload VÁLIDO grava vistoria + 3 itens.
    const ok = await inspectionsService.createInspectionWithItems(
      { ...base(), propertyId: property.id, inspectionType: 'CHECK_IN', items: [
        { itemName: names[0], condition: 'GOOD' }, { itemName: names[1], condition: 'GOOD' },
        { itemName: names[2], condition: 'DAMAGED', damageDescription: 'Pia trincada', estimatedBudget: 300, responsibleParty: 'TENANT' },
      ] },
      tenant.userId,
      t
    );
    assert.equal(ok.items.length, 3);
  });
});

test('vistoria: lockVersion — instância desatualizada não sobrescreve (OptimisticLockError) e expectedLockVersion antigo dá 409', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const property = await Property.create(
      { ...base(), propertyType: 'RESIDENTIAL', title: `F5 VV ${uniqueSuffix()}`, internalCode: `F5VV-${uniqueSuffix()}`, createdBy: tenant.userId },
      { transaction: t }
    );
    const created = await inspectionsService.createInspection({ ...base(), propertyId: property.id, inspectionType: 'CHECK_IN' }, tenant.userId, t);
    const v0 = created.lockVersion;

    const a = await models.Inspection.findByPk(created.id, { transaction: t });
    const b = await models.Inspection.findByPk(created.id, { transaction: t });
    a.scheduledAt = new Date();
    await a.save({ transaction: t });
    assert.equal(a.lockVersion, v0 + 1);
    b.status = 'COMPLETED';
    await assert.rejects(sequelize.transaction({ transaction: t }, (sp) => b.save({ transaction: sp })), (err) => err.name === 'SequelizeOptimisticLockError');

    await assert.rejects(
      inspectionsService.completeInspection(created.id, tenant.userId, t, { expectedLockVersion: v0 }),
      (err) => err.code === 'LEGAL_INSPECTION_VERSION_CONFLICT'
    );
    const still = await models.Inspection.findByPk(created.id, { transaction: t });
    assert.notEqual(still.status, 'COMPLETED');

    const done = await inspectionsService.completeInspection(created.id, tenant.userId, t, { expectedLockVersion: v0 + 1 });
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.lockVersion, v0 + 2);
  });
});
