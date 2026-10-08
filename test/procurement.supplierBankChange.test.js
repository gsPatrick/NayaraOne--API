'use strict';

// Contrato bruto (Caderno COMPRAS/PROCUREMENT + SEGUROS — BLINDADO): "Fornecedores: cadastro
// mestre; banco via fluxo IAM blindado" e, em Testes/DoD, "banco fornecedor alterado".
//
// Fornecedor é uma Person; a conta bancária dele é uma finance.bank_accounts com
// owner_person_id = fornecedor (o mesmo model compartilhado por todo o Financeiro). Procurement
// nunca escreve em BankAccount diretamente — o payable nasce do recebimento (confirmGoodsReceipt)
// e o pagamento passa por financialEntries.settleFinancialEntry, que chama
// financeAntifraud.assertBankAccountEligibleForPayment. Estes testes exercitam essa cadeia real
// de ponta a ponta, no contexto de um fornecedor:
//
//   PO -> recebimento -> payable -> conta do fornecedor -> pagamento OK
//   fornecedor troca dado bancário -> conta volta a PENDING_COOLDOWN -> pagamento seguinte BLOQUEADO
//
// e cobrem as duas brechas reais encontradas nesta auditoria (bankAccounts.service.js):
//   (1) reatribuir ao fornecedor uma conta já ACTIVE (ownerPersonId) não reabria o cooldown;
//   (2) trocar PIX com a conta BLOCKED e depois desbloquear ia direto pra ACTIVE.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const procurementService = require('../src/features/procurement/procurement.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const antifraudService = require('../src/features/finance/financeAntifraud.service');
const { Person, BankAccount, FinancialEntry } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function actorOf() {
  return { userId: tenant.userId, canApprove: true };
}

async function createPerson(transaction, label) {
  return Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `${label} ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

/**
 * Cadastra uma conta e faz ela passar pelo resfriamento de verdade: recua created_at/updated_at
 * para muito além de qualquer limiar de cooldown (FIN-005, default 48h) e deixa a própria lazy
 * transition de assertBankAccountEligibleForPayment promovê-la para ACTIVE — o mesmo caminho que
 * uma conta real percorre em produção, sem setar status=ACTIVE "por fora".
 */
async function createVerifiedAccount(transaction, ownerPersonId, suffix) {
  const account = await bankAccountsService.createBankAccount(
    withTenant({ ownerPersonId, bankCode: '341', agency: '0001', accountNumber: `FORN-${suffix}`, pixKey: `pix-original-${suffix}@fornecedor.dev` }),
    tenant.userId,
    transaction
  );
  assert.equal(account.status, 'PENDING_COOLDOWN', 'conta nova sempre nasce em resfriamento');
  await sequelize.query(
    "UPDATE finance.bank_accounts SET created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = :id",
    { replacements: { id: account.id }, transaction }
  );
  const promoted = await antifraudService.assertBankAccountEligibleForPayment(account.id, transaction);
  assert.equal(promoted.status, 'ACTIVE', 'cooldown vencido promove a conta para ACTIVE (lazy transition)');
  return promoted;
}

async function createAwardedOrder(transaction, supplierPersonId, quantity = 10, unitPrice = 50) {
  const s = uniqueSuffix();
  const item = await itemsService.createItem(withTenant({ name: `QA Forn Banco item ${s}`, sku: `SKU-FB-${s}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
  const location = await itemsService.createLocation(withTenant({ name: `QA Forn Banco depósito ${s}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', tenant.userId, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  return { order, location };
}

// Recebe `receivedQuantity` do PO e devolve o payable (FinancialEntry) que o próprio Procurement
// gerou, já apontado para a conta bancária do fornecedor.
async function receiveAndPointPayableTo(transaction, order, location, receivedQuantity, bankAccountId) {
  const { goodsReceipt } = await procurementService.confirmGoodsReceipt(
    order.id, tenant.groupId, tenant.companyId,
    { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity }] },
    actorOf(),
    transaction
  );
  assert.ok(goodsReceipt.financialEntryId, 'recebimento confirmado precisa gerar o payable do fornecedor');
  return financialEntriesService.updateFinancialEntry(goodsReceipt.financialEntryId, { bankAccountId }, tenant.userId, transaction);
}

function assertCooldownError(err) {
  assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN');
  return true;
}

test('Banco fornecedor alterado: troca de PIX do fornecedor reabre o cooldown e bloqueia o pagamento seguinte do payable de compras', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await createPerson(transaction, 'QA Fornecedor banco');
    const account = await createVerifiedAccount(transaction, supplier.id, suffix);
    const { order, location } = await createAwardedOrder(transaction, supplier.id);

    // Controle: com a conta verificada, o primeiro payable (recebimento parcial) é pago normalmente.
    const firstPayable = await receiveAndPointPayableTo(transaction, order, location, 4, account.id);
    const settled = await financialEntriesService.settleFinancialEntry(firstPayable.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED', 'conta do fornecedor já verificada paga normalmente');

    // O fornecedor "avisa" que trocou de banco — alteração feita pelo caminho guardado do Financeiro.
    const changed = await bankAccountsService.updateBankAccount(
      account.id,
      { pixKey: `pix-novo-${suffix}@fornecedor.dev` },
      tenant.userId,
      transaction
    );
    assert.equal(changed.status, 'PENDING_COOLDOWN', 'troca de dado bancário do fornecedor volta a conta para resfriamento');

    // O pagamento seguinte do MESMO fornecedor, pela MESMA conta, fica retido.
    const secondPayable = await receiveAndPointPayableTo(transaction, order, location, 6, account.id);
    await assert.rejects(() => financialEntriesService.settleFinancialEntry(secondPayable.id, tenant.userId, transaction), assertCooldownError);
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(secondPayable.id, 10, tenant.userId, transaction),
      assertCooldownError,
      'baixa parcial não pode ser atalho para pagar a conta recém-alterada'
    );

    // Promover manualmente a conta para ACTIVE durante o cooldown também é recusado.
    await assert.rejects(() => bankAccountsService.updateBankAccount(account.id, { status: 'ACTIVE' }, tenant.userId, transaction), assertCooldownError);

    const reread = await FinancialEntry.findByPk(secondPayable.id, { transaction });
    assert.equal(reread.status, 'PENDING', 'nada foi liquidado para a conta em reverificação');
  });
});

test('Banco fornecedor alterado: reatribuir ao fornecedor uma conta já ACTIVE de outro titular reabre o cooldown (ownerPersonId é sensível)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await createPerson(transaction, 'QA Fornecedor legítimo');
    const otherHolder = await createPerson(transaction, 'QA Outro titular');
    // Conta de OUTRO titular, que já passou pelo resfriamento há muito tempo.
    const foreignAccount = await createVerifiedAccount(transaction, otherHolder.id, `${suffix}-mule`);

    const reassigned = await bankAccountsService.updateBankAccount(foreignAccount.id, { ownerPersonId: supplier.id }, tenant.userId, transaction);
    assert.equal(reassigned.ownerPersonId, supplier.id);
    assert.equal(reassigned.status, 'PENDING_COOLDOWN', 'conta "nova" para este fornecedor precisa passar pelo resfriamento');

    const supplierAccounts = await bankAccountsService.listBankAccounts(transaction, { ownerPersonId: supplier.id });
    assert.deepEqual(supplierAccounts.map((a) => [a.id, a.status]), [[foreignAccount.id, 'PENDING_COOLDOWN']]);

    const { order, location } = await createAwardedOrder(transaction, supplier.id);
    const payable = await receiveAndPointPayableTo(transaction, order, location, 10, foreignAccount.id);
    await assert.rejects(() => financialEntriesService.settleFinancialEntry(payable.id, tenant.userId, transaction), assertCooldownError);
  });
});

test('Banco fornecedor alterado: trocar o PIX com a conta BLOQUEADA e depois desbloquear não pula o cooldown', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await createPerson(transaction, 'QA Fornecedor bloqueado');
    const account = await createVerifiedAccount(transaction, supplier.id, suffix);

    await bankAccountsService.blockBankAccount(account.id, 'suspeita de fraude', tenant.userId, transaction);
    const changedWhileBlocked = await bankAccountsService.updateBankAccount(
      account.id,
      { pixKey: `pix-trocado-no-bloqueio-${suffix}@fornecedor.dev` },
      tenant.userId,
      transaction
    );
    assert.equal(changedWhileBlocked.status, 'BLOCKED', 'alterar dado com a conta bloqueada mantém o bloqueio');

    const unblocked = await bankAccountsService.updateBankAccount(account.id, { status: 'ACTIVE' }, tenant.userId, transaction);
    assert.equal(unblocked.status, 'PENDING_COOLDOWN', 'desbloqueio devolve a conta para reverificação, nunca direto para ACTIVE');

    const { order, location } = await createAwardedOrder(transaction, supplier.id);
    const payable = await receiveAndPointPayableTo(transaction, order, location, 10, account.id);
    await assert.rejects(() => financialEntriesService.settleFinancialEntry(payable.id, tenant.userId, transaction), assertCooldownError);
    await assert.rejects(() => bankAccountsService.updateBankAccount(account.id, { status: 'ACTIVE' }, tenant.userId, transaction), assertCooldownError);
  });
});

test('Banco fornecedor: reenviar os MESMOS dados (inclusive o mesmo titular) não reabre o cooldown nem trava o pagamento', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await createPerson(transaction, 'QA Fornecedor estável');
    const account = await createVerifiedAccount(transaction, supplier.id, suffix);

    const same = await bankAccountsService.updateBankAccount(
      account.id,
      { ownerPersonId: supplier.id, bankCode: account.bankCode, agency: account.agency, accountNumber: account.accountNumber, pixKey: account.pixKey },
      tenant.userId,
      transaction
    );
    assert.equal(same.status, 'ACTIVE', 'sem mudança real de dado sensível a conta continua ACTIVE');

    const { order, location } = await createAwardedOrder(transaction, supplier.id);
    const payable = await receiveAndPointPayableTo(transaction, order, location, 10, account.id);
    const settled = await financialEntriesService.settleFinancialEntry(payable.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED');

    const reread = await BankAccount.findByPk(account.id, { transaction });
    assert.equal(reread.status, 'ACTIVE');
  });
});
