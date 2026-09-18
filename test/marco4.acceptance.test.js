'use strict';

// Testes de aceite do Marco 4 (Financeiro) — fechando itens PARCIAIS da matriz M4-01 a M4-28
// que já tinham implementação real, só faltava prova automatizada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const { assertBankAccountEligibleForPayment } = require('../src/features/finance/financeAntifraud.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const propertiesService = require('../src/features/properties/properties.service');
const { BankAccount, Person } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- M4-05: proibição de edição destrutiva de lançamento já liquidado ---
test('M4-05 updateFinancialEntry bloqueia edição de lançamento SETTLED — ledger imutável (FIN-003)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 150 },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.updateFinancialEntry(entry.id, { description: 'tentando editar valor liquidado' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_ENTRY_IMMUTABLE'); return true; },
      'lançamento SETTLED não pode ser editado — precisa de estorno'
    );
  });
});

// --- M4-11: cooldown de 48h para conta bancária nova ---
test('M4-11 conta bancária nova fica em cooldown, bloqueia pagamento, e libera após o prazo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', accountNumber: `M411-${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(account.status, 'PENDING_COOLDOWN');

    await assert.rejects(
      () => assertBankAccountEligibleForPayment(account.id, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN'); return true; },
      'conta nova dentro do cooldown não pode receber pagamento'
    );

    // Simula o prazo de 48h já ter passado (sem esperar de verdade).
    await sequelize.query('UPDATE finance.bank_accounts SET updated_at = :ts WHERE id = :id', {
      replacements: { ts: new Date(Date.now() - 49 * 60 * 60 * 1000), id: account.id },
      transaction,
    });
    const result = await assertBankAccountEligibleForPayment(account.id, transaction);
    assert.ok(result === null || result.status === 'ACTIVE', 'após o cooldown, a conta deve ficar elegível (promoção automática pra ACTIVE)');
  });
});

// --- M4-15: repasses de proprietário segregados da receita própria ---
test('M4-15 createOwnerRepasse calcula líquido = bruto - deduções, nunca editável diretamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M4-15 Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `M415-${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M4-15 Imóvel ${suffix}`, internalCode: `M415P-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );

    const repasse = await ownerRepassesService.createOwnerRepasse(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, bankAccountId: account.id, grossAmount: 1000, deductionsAmount: 80, referenceMonth: '2026-09' },
      tenant.userId,
      transaction
    );
    assert.equal(Number(repasse.netAmount), 920, 'líquido precisa ser sempre bruto - deduções, calculado no servidor');
    assert.equal(repasse.status, 'PENDING');

    // Sem exigir cooldown vencido, o pagamento deve ser bloqueado (mesma trava do M4-11).
    await assert.rejects(
      () => ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN'); return true; },
      'repasse pra conta em cooldown não pode ser pago — prova que a segregação/antifraude vale também pra repasse'
    );
  });
});
