'use strict';

// M45 F4 — Novo repasse: lista de recebimentos elegíveis filtrada por imóvel/contrato/período,
// com a MESMA regra que a criação valida (sourceIneligibility + escopo), e caminho feliz completo
// (criar -> aprovar por outra pessoa) dentro de transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const contractsService = require('../src/features/legal/contracts.service');
const { User, BankAccount, Person, Property } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function setup(t) {
  const suffix = uniqueSuffix();
  const owner = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proprietário M45 ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const mkProperty = (n) => Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel M45 ${n} ${suffix}`, internalCode: `M45R${n}-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const propA = await mkProperty('A');
  const propB = await mkProperty('B');
  const mkContract = (p) => contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', propertyId: p.id, totalValue: 1000 }, tenant.userId, t);
  const contractA = await mkContract(propA);
  const contractB = await mkContract(propB);
  const rc = await createTestResultCenter(tenant, t);
  const mkReceived = async (contract, amount, competenceMonth, extra = {}) => {
    const e = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId: rc.id, contractId: contract.id, competenceMonth, dueAt: new Date(`${competenceMonth}-10T12:00:00Z`), description: `Aluguel M45 ${competenceMonth} ${suffix}`, ...extra },
      tenant.userId, t
    );
    if (extra.settle !== false) await financialEntriesService.settleFinancialEntry(e.id, tenant.userId, t);
    return e;
  };
  return { owner, propA, propB, contractA, contractB, mkReceived };
}

test('M45-F4 elegíveis: só recebimentos liquidados do imóvel/contrato, até o período, com saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { propA, contractA, contractB, mkReceived } = await setup(t);
    const okSep = await mkReceived(contractA, 1500, '2026-09');
    const okOct = await mkReceived(contractA, 1600, '2026-10');
    const otherProperty = await mkReceived(contractB, 999, '2026-09');
    const notReceived = await mkReceived(contractA, 700, '2026-09', { settle: false });

    const sep = await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: propA.id, referenceMonth: '2026-09' });
    const ids = sep.map((e) => e.id);
    assert.ok(ids.includes(okSep.id));
    assert.ok(!ids.includes(okOct.id), 'competência posterior ao período não entra');
    assert.ok(!ids.includes(otherProperty.id), 'recebimento de outro imóvel não entra');
    assert.ok(!ids.includes(notReceived.id), 'recebimento não liquidado não entra');
    assert.equal(sep.find((e) => e.id === okSep.id).availableAmount, 1500);

    const oct = await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: propA.id, contractId: contractA.id, referenceMonth: '2026-10' });
    assert.deepEqual(new Set(oct.map((e) => e.id)), new Set([okSep.id, okOct.id]));
    // Contrato de outro imóvel: lista vazia.
    assert.equal((await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: propA.id, contractId: contractB.id })).length, 0);
  });
});

test('M45-F4 criação recusa recebimento de outro imóvel/contrato (mesma regra da lista)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { owner, propA, contractA, contractB, mkReceived } = await setup(t);
    const foreign = await mkReceived(contractB, 800, '2026-09');
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: propA.id, ownerPersonId: owner.id, referenceMonth: '2026-09', sourceEntryIds: [foreign.id] };
    await assert.rejects(() => ownerRepassesService.createOwnerRepasse(base, tenant.userId, t), (e) => e.code === 'FINANCE_OWNER_REPASSE_SOURCE_OUT_OF_SCOPE');
    await assert.rejects(() => ownerRepassesService.createOwnerRepasse({ ...base, contractId: contractA.id }, tenant.userId, t), (e) => e.code === 'FINANCE_OWNER_REPASSE_SOURCE_OUT_OF_SCOPE');
  });
});

test('M45-F4 caminho feliz: lista -> cria repasse válido -> aprovado por outra pessoa -> saldo consumido sai da lista', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { owner, propA, contractA, mkReceived } = await setup(t);
    const received = await mkReceived(contractA, 2000, '2026-09');
    const eligible = await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: propA.id, contractId: contractA.id, referenceMonth: '2026-09' });
    assert.deepEqual(eligible.map((e) => e.id), [received.id]);

    const bank = await BankAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `M45R-${uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t });
    const repasse = await ownerRepassesService.createOwnerRepasse(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: propA.id, contractId: contractA.id, ownerPersonId: owner.id, bankAccountId: bank.id, referenceMonth: '2026-09', sourceEntryIds: eligible.map((e) => e.id), deductionsAmount: 200 },
      tenant.userId, t
    );
    assert.equal(repasse.status, 'PENDING');
    assert.equal(Number(repasse.grossAmount), 2000);
    assert.equal(Number(repasse.netAmount), 1800);

    const checker = await User.create({ email: `m45-checker-${uniqueSuffix()}@nayaraone.dev`, name: 'M45 checker', passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });
    const cc = await createTestCostCenter(tenant, t);
    const { repasse: approved, financialEntry } = await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: cc.id }, checker.id, t);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(financialEntry.nature, 'PAYABLE');
    assert.equal(Number(financialEntry.amount), 1800);

    const composition = await ownerRepassesService.getOwnerRepasseComposition(repasse.id, t);
    assert.equal(composition.composition[0].financialEntryId, received.id);
    // Saldo inteiro consumido: o recebimento sai da lista do próximo período.
    const next = await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: propA.id, contractId: contractA.id, referenceMonth: '2026-10' });
    assert.ok(!next.some((e) => e.id === received.id));
  });
});
