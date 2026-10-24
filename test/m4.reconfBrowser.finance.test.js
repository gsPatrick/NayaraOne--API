'use strict';

// Conferência ao vivo do Marco 4 (Claude Browser, 20/10/2026) — correções do backend.
// F-05: trocar o favorecido invalida a intenção de pagamento e abre revisão.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const { User, PaymentIntent, AnomalyCase } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function activeAccount(t, tag) {
  const a = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `rb-${tag}` }, tenant.userId, t);
  a.status = 'ACTIVE';
  await a.save({ transaction: t });
  return a;
}
async function approver(t) {
  const [u] = await User.findOrCreate({ where: { email: `rb-approver-${uniqueSuffix()}@nayaraone.dev` }, defaults: { name: 'RB aprovador', passwordHash: 'x', status: 'ACTIVE' }, transaction: t });
  return u.id;
}

test('F-05: trocar a conta do favorecido cancela a intenção aprovada, abre caso de revisão e libera nova intenção', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const cc = await createTestCostCenter(tenant, t);
    const a = await activeAccount(t, `a-${sfx}`);
    const b = await activeAccount(t, `b-${sfx}`);
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 321.1, description: `F05 ${sfx}`, costCenterId: cc.id, bankAccountId: a.id, dueAt: new Date(Date.now() + 86400000) },
      tenant.userId, t);
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await paymentIntentsService.approvePaymentIntent(intent.id, await approver(t), t);

    await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: b.id }, tenant.userId, t);

    const after1 = await PaymentIntent.findByPk(intent.id, { transaction: t });
    assert.equal(after1.status, 'CANCELLED', 'a intenção aprovada sobre a conta antiga precisa ser invalidada');
    assert.match(after1.cancelReason, /alterado após a aprovação/i);
    const cases = await AnomalyCase.findAll({ where: { relatedEntityId: entry.id, caseType: 'BENEFICIARY_CHANGED' }, transaction: t });
    assert.equal(cases.length, 1, 'a troca de favorecido abre um caso de revisão');
    assert.equal(cases[0].riskLevel, 'HIGH');
    await entry.reload({ transaction: t });
    assert.equal(entry.requiresManualReview, true);
    // libera nova intenção sobre a versão atual
    const again = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    assert.equal(again.status, 'PENDING');
    assert.equal(again.snapshotJson.bankAccountId, b.id);
  });
});

test('F-05 (controle): primeira definição da conta e edição sem mudar o retrato não invalidam nem abrem caso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const cc = await createTestCostCenter(tenant, t);
    const a = await activeAccount(t, `c-${sfx}`);
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 50, description: `F05c ${sfx}`, costCenterId: cc.id, dueAt: new Date(Date.now() + 86400000) },
      tenant.userId, t);
    await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: a.id }, tenant.userId, t);
    assert.equal(await AnomalyCase.count({ where: { relatedEntityId: entry.id, caseType: 'BENEFICIARY_CHANGED' }, transaction: t }), 0, 'primeira definição não é redirecionamento');
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: a.id, description: `F05c ${sfx}` }, tenant.userId, t);
    assert.equal((await PaymentIntent.findByPk(intent.id, { transaction: t })).status, 'PENDING');
  });
});

// ---- F-07 / F-08: repasse (lista de elegíveis, duplicado e dedução) com mensagens em português
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const contractsService = require('../src/features/legal/contracts.service');
const { Person, Property } = require('../src/models');
const { createTestResultCenter } = require('./testHelpers');

async function repasseSetup(t) {
  const sfx = uniqueSuffix();
  const owner = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proprietário RB ${sfx}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const prop = await Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel RB ${sfx}`, internalCode: `RB-${sfx}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE_RESIDENTIAL', propertyId: prop.id, totalValue: 1000 }, tenant.userId, t);
  const rc = await createTestResultCenter(tenant, t);
  const e = await financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, resultCenterId: rc.id, contractId: contract.id, competenceMonth: '2026-09', dueAt: new Date('2026-09-10T15:00:00Z') },
    tenant.userId, t);
  await financialEntriesService.settleFinancialEntry(e.id, tenant.userId, t);
  return { owner, prop, e, base: { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: prop.id, ownerPersonId: owner.id, referenceMonth: '2026-09', sourceEntryIds: [e.id] } };
}

test('F-08: dedução sem motivo, valor acima do elegível e repasse duplicado voltam com mensagem clara em português e código estável', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base, prop, e } = await repasseSetup(t);
    const plain = (err) => !/[a-z]+[A-Z][a-zA-Z]+|"[a-zA-Z]+"/.test(err.message.replace(/\b(PIX)\b/g, ''));
    await assert.rejects(() => ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 500, deductionsAmount: 100 }, tenant.userId, t),
      (err) => err.code === 'FINANCE_OWNER_REPASSE_DEDUCTION_REASON_REQUIRED' && /motivo do desconto/.test(err.message) && plain(err));
    await assert.rejects(() => ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 5000 }, tenant.userId, t),
      (err) => err.code === 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP' && /R\$/.test(err.message) && /ajuste formal/.test(err.message) && plain(err));
    const created = await ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 400, deductionsAmount: 50, deductionsReason: 'Taxa de administração' }, tenant.userId, t);
    assert.ok(created.id);
    await assert.rejects(() => ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 300 }, tenant.userId, t),
      (err) => err.code === 'FINANCE_OWNER_REPASSE_PERIOD_DUPLICATE' && /09\/2026/.test(err.message) && /aguardando aprovação/.test(err.message) && plain(err));
    // F-07: o recebimento já usado em parte continua na lista só com o saldo que sobrou
    const list = await ownerRepassesService.listEligibleRepasseSources(t, { propertyId: prop.id, referenceMonth: '2026-09' });
    assert.equal(list.find((x) => x.id === e.id).availableAmount, 600);
  });
});

// ---- F-11: as duas medidas de terceiros do relatório de saúde dizem o que medem
const healthService = require('../src/features/finance/financialHealthReport.service');

test('Relatório de saúde: "em aberto (previsto)" e "retido em caixa (realizado)" são medidas rotuladas e distintas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const report = await healthService.getWeeklyHealthReport(t, { now: new Date() });
    assert.equal(report.thirdPartyFunds.basis, 'PENDING');
    assert.match(report.thirdPartyFunds.label, /em aberto/);
    assert.equal(report.freeCash.thirdPartyHeldBasis, 'SETTLED');
    assert.match(report.freeCash.thirdPartyHeldLabel, /retido em caixa/);
    assert.notEqual(report.thirdPartyFunds.label, report.freeCash.thirdPartyHeldLabel);
    assert.match(report.freeCash.thirdPartyHeldDescription, /Difere do total em aberto/);
  });
});
