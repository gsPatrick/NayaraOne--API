'use strict';

// Caderno M4 §12 "Repasse não pode ser maior que valor elegível recebido, salvo ajuste formal". Verificação independente
// 11/11/2026, sonda P8: o aluguel de 1.500 recebido em 750 + 750 entrava no teto como PAI 1.500 + FILHA 750 + FILHA 750 =
// 3.000 e o repasse de 3.000 era aceito. O teto é o que o recebimento realizou no ledger (as baixas somadas, sem o pai).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { uniqueSuffix, withRollbackTenantTransaction, withTenantTransaction, sequelize, createTestResultCenter } = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const entriesSvc = require('../src/modules/finance/application/services/financial-entry.service');
const receipt = require('../src/modules/finance/application/services/receipt.service');
const ownerRepasses = require('../src/modules/finance/application/services/owner-repasses.service');
const contracts = require('../src/modules/legal/contracts/application/contract.service');
const { Person, Property, BankAccount } = require('../src/models');

let tenant;
let rc;

before(async () => {
  tenant = await isolatedTenant('m4lr-repasse');
  rc = await withTenantTransaction(tenant, async (t) => (await createTestResultCenter(tenant, t)).id);
});

after(async () => {
  await closeIsolated();
  await sequelize.close();
});

async function setup(t, settlements) {
  const s = uniqueSuffix();
  const owner = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proprietário M4LR ${s}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const prop = await Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel M4LR ${s}`, internalCode: `M4LR-${s}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const contract = await contracts.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', propertyId: prop.id, totalValue: 1500 }, tenant.userId, t);
  const rent = await entriesSvc.createFinancialEntry({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '1500.00', resultCenterId: rc, contractId: contract.id, competenceMonth: '2026-09', dueAt: new Date('2026-09-10T12:00:00Z'), description: `Aluguel M4LR ${s}` }, tenant.userId, t);
  const children = [];
  for (const amount of settlements) children.push((await receipt.settleFinancialEntryPartial(rent.id, amount, tenant.userId, t, { idempotencyKey: `m4lr-rep-${uniqueSuffix()}` })).settlement);
  const bank = await BankAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `M4LR-R-${s}`, status: 'ACTIVE' }, { transaction: t });
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: prop.id, contractId: contract.id, ownerPersonId: owner.id, bankAccountId: bank.id, referenceMonth: '2026-09' };
  return { rent, children, base, prop, contract };
}

const codeOf = (p) => p.then(() => null, (e) => e.code);

test('M4-§12.3 (sonda P8): aluguel de 1.500 recebido em 750 + 750 tem 1.500 elegíveis; repasse de 3.000 é recusado e o de 1.500 passa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { rent, children, base, prop, contract } = await setup(t, ['750.00', '750.00']);
    const eligible = await ownerRepasses.listEligibleRepasseSources(t, { propertyId: prop.id, contractId: contract.id, referenceMonth: '2026-09' });
    assert.deepEqual(eligible.map((e) => ({ id: e.id, availableAmount: e.availableAmount })), [{ id: rent.id, availableAmount: 1500 }], 'só o recebimento, pelo que as baixas realizaram');
    const dobro = await codeOf(ownerRepasses.createOwnerRepasse({ ...base, sourceEntryIds: [rent.id, ...children.map((c) => c.id)], grossAmount: 3000 }, tenant.userId, t));
    assert.equal(dobro, 'FINANCE_OWNER_REPASSE_SOURCE_IS_PARTIAL_SETTLEMENT', 'a baixa parcial não é fonte à parte');
    const acima = await codeOf(ownerRepasses.createOwnerRepasse({ ...base, sourceEntryIds: [rent.id], grossAmount: 3000 }, tenant.userId, t));
    assert.equal(acima, 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP');
    const ok = await ownerRepasses.createOwnerRepasse({ ...base, sourceEntryIds: [rent.id], grossAmount: 1500 }, tenant.userId, t);
    assert.equal(ok.grossAmount, '1500.00');
  });
});

test('M4-§12.3: recebido só em parte (750 de 1.500) tem 750 elegíveis; a baixa estornada sai do teto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { rent, children, base, prop, contract } = await setup(t, ['750.00']);
    const list = await ownerRepasses.listEligibleRepasseSources(t, { propertyId: prop.id, contractId: contract.id, referenceMonth: '2026-09' });
    assert.deepEqual(list.map((e) => e.availableAmount), [750]);
    assert.equal(await codeOf(ownerRepasses.createOwnerRepasse({ ...base, sourceEntryIds: [rent.id], grossAmount: 751 }, tenant.userId, t)), 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP');
    await receipt.reverseFinancialEntry(children[0].id, 'baixa devolvida pelo banco', tenant.userId, t);
    const depois = await ownerRepasses.listEligibleRepasseSources(t, { propertyId: prop.id, contractId: contract.id, referenceMonth: '2026-09' });
    assert.deepEqual(depois, [], 'nada realizado, nada a repassar');
  });
});
