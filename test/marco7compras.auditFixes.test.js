'use strict';

// Auditoria Marco 7 — rodada Compras E2E (Claude Browser, 18/10/2026, relatório
// auditoria_marco7compras_local.md). Prova em banco real (RLS ativo, mesmo caminho do runtime)
// as correções dos achados:
//   C1 — excedente de over-receipt só entra no SALDO DE ESTOQUE quando a divergência é ACEITA
//        (rejeitada: nunca entra, trilha de devolução na resolução);
//   C3 — requisição de compra avança para DELIVERED quando o PO é totalmente recebido;
//   C4 — número da NF do recebimento de Compras aparece no movimento de estoque e na listagem
//        de pedidos (invoiceNumbers);
//   C5 — parcela de prêmio de seguro nasce com o PRÓPRIO payable vinculado, e a baixa rejeita
//        qualquer outro lançamento (mesmo PAYABLE/SETTLED de valor igual de outro contexto).
// (C2 — permissões do papel de homologação — é seed/ambiente, provado ao vivo pelo JWT;
//  o negativo do maker-checker já é coberto por procurement.approvalSegregation.test.js.)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
// Revisão Marco 7 (19/10/2026, B10): adjudicação exige fornecedor qualificado (documento + vigência).
const { createQualifiedSupplier } = require('./procurementTestSupplier');
const procurementService = require('../src/features/procurement/procurement.service');
const insuranceService = require('../src/features/procurement/insurance.service');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const { User, PurchaseRequest, FinancialEntry, InventoryMovement } = require('../src/models');

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

function actorOf(extra) {
  return { userId: tenant.userId, canApprove: true, ...extra };
}

function actorWithTenant(extra) {
  return { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, ...extra };
}

async function createItemAndWarehouse(transaction) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `M7COMPRAS Item ${suffix}`, sku: `SKU-M7C-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `M7COMPRAS Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function fullProcurementCycle(transaction, { item, quantity = 25, unitPrice = 4 }) {
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  const suffix = uniqueSuffix();
  const secondApprover = await User.create(
    { name: `QA M7COMPRAS aprovador ${suffix}`, email: `qa-m7compras-approver-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id,
    tenant.groupId,
    tenant.companyId,
    { supplierPersonId: (await createQualifiedSupplier(tenant, transaction)).supplierPersonId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  return { request, quotation, offer, order };
}

async function balanceOf(itemId, locationId, transaction) {
  const balance = await movementsService.getBalance(itemId, locationId, tenant.groupId, tenant.companyId, transaction);
  return Number(balance?.quantity ?? balance ?? 0);
}

// ---------------------------------------------------------------------------------------------
// C1 — over-receipt: excedente fora do saldo até a decisão
// ---------------------------------------------------------------------------------------------

test('C1: receber 30 de um PO de 25 sobe o saldo em 25; ACEITAR a divergência sobe os 5 restantes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, quantity: 25, unitPrice: 4 });

    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 30 }] },
      actorOf(),
      transaction
    );
    const overReceipt = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT');
    assert.ok(overReceipt, 'precisa abrir a divergência OVER_RECEIPT');

    const saldoAntesDaDecisao = await balanceOf(item.id, location.id, transaction);
    assert.equal(saldoAntesDaDecisao, 25, 'o excedente (5) não pode entrar no saldo antes da decisão humana da divergência');

    // FIX (auditoria "reconf" 18/10): resolvedor precisa ser diferente de quem recebeu.
    const resolver = await User.create(
      { name: `QA M7C resolvedor ${uniqueSuffix()}`, email: `qa-m7c-resolver-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );
    await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, { userId: resolver.id }, transaction
    );

    const saldoDepoisDoAceite = await balanceOf(item.id, location.id, transaction);
    assert.equal(saldoDepoisDoAceite, 30, 'aceitar a divergência incorpora o excedente (5) ao saldo');
  });
});

test('C1: REJEITAR a divergência de over-receipt mantém o saldo em 25 e registra a devolução na resolução', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, quantity: 25, unitPrice: 4 });

    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 30 }] },
      actorOf(),
      transaction
    );
    const overReceipt = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT');

    // FIX (auditoria "reconf" 18/10): resolvedor distinto + justificativa obrigatória.
    const resolver = await User.create(
      { name: `QA M7C resolvedor ${uniqueSuffix()}`, email: `qa-m7c-resolver-rej-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );
    const resolved = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED', notes: 'Excedente recusado no portão (teste).' }, { userId: resolver.id }, transaction
    );

    const saldo = await balanceOf(item.id, location.id, transaction);
    assert.equal(saldo, 25, 'excedente rejeitado nunca entra no saldo');
    assert.match(String(resolved.resolutionNotes || ''), /devolução ao fornecedor/i, 'a resolução precisa deixar a trilha da devolução');
  });
});

// ---------------------------------------------------------------------------------------------
// C3 — requisição avança pra DELIVERED no recebimento total
// ---------------------------------------------------------------------------------------------

test('C3: recebimento TOTAL do PO leva a requisição de AWARDED para DELIVERED; parcial mantém AWARDED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { request, order } = await fullProcurementCycle(transaction, { item, quantity: 10, unitPrice: 2 });

    assert.equal((await PurchaseRequest.findByPk(request.id, { transaction })).status, 'AWARDED');

    await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 4 }] },
      actorOf(),
      transaction
    );
    assert.equal(
      (await PurchaseRequest.findByPk(request.id, { transaction })).status,
      'AWARDED',
      'recebimento parcial não fecha a requisição'
    );

    await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 6 }] },
      actorOf(),
      transaction
    );
    assert.equal(
      (await PurchaseRequest.findByPk(request.id, { transaction })).status,
      'DELIVERED',
      'recebimento total fecha o ciclo da requisição (Entregue)'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// C4 — NF do recebimento de Compras rastreável no movimento e na listagem de POs
// ---------------------------------------------------------------------------------------------

test('C4: a NF informada no recebimento de Compras aparece no motivo do movimento de estoque e em listPurchaseOrders', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, quantity: 5, unitPrice: 3 });
    const nf = `NF-M7C-${uniqueSuffix()}`;

    await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, invoiceFingerprint: nf, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 5 }] },
      actorOf(),
      transaction
    );

    const movement = await InventoryMovement.findOne({
      where: { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: item.id, movementType: 'IN' },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(movement, 'o recebimento precisa ter gerado o movimento IN');
    assert.match(String(movement.reason || ''), new RegExp(nf), 'o motivo do movimento precisa citar a NF do recebimento');

    const orders = await procurementService.listPurchaseOrders(tenant.groupId, tenant.companyId, transaction, {});
    const listed = orders.find((o) => o.id === order.id);
    assert.ok(listed, 'o PO precisa aparecer na listagem');
    assert.ok(
      Array.isArray(listed.invoiceNumbers) && listed.invoiceNumbers.includes(nf),
      'a listagem de POs precisa expor o(s) número(s) de NF dos recebimentos'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// C5 — parcela de seguro nasce com o próprio payable; baixa só aceita o vinculado
// ---------------------------------------------------------------------------------------------

async function issuePolicyWithInstallments(transaction, installmentsCount = 2) {
  const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
  await insuranceService.quotePolicy(policy.id, { estimatedValue: 50000 }, actorWithTenant(), transaction);
  const issued = await insuranceService.issuePolicy(
    policy.id,
    { effectiveDate: '2026-01-01', expiryDate: '2026-12-31', installmentsCount },
    actorWithTenant(),
    transaction
  );
  const installments = await insuranceService.listPolicyInstallments(policy.id, tenant.groupId, tenant.companyId, transaction);
  return { policy: issued, installments };
}

test('C5: cada parcela do prêmio nasce com o próprio lançamento PAYABLE vinculado (linkedEntry)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { installments } = await issuePolicyWithInstallments(transaction, 2);
    assert.equal(installments.length, 2);
    for (const inst of installments) {
      assert.ok(inst.financialEntryId, 'parcela precisa nascer vinculada ao próprio payable');
      assert.ok(inst.linkedEntry, 'listPolicyInstallments precisa anexar o lançamento vinculado');
      assert.equal(inst.linkedEntry.id, inst.financialEntryId);
      assert.match(String(inst.linkedEntry.description), /Prêmio de seguro — parcela/);
      assert.equal(Number(inst.linkedEntry.amount), Number(inst.amount), 'valor do payable = valor da parcela');
      const entry = await FinancialEntry.findByPk(inst.financialEntryId, { transaction });
      assert.equal(entry.nature, 'PAYABLE');
    }
  });
});

test('C5: baixa com um lançamento DIFERENTE do vinculado é rejeitada mesmo sendo PAYABLE/SETTLED de valor igual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { settleFinancialEntryWithApproval, createTestCostCenter } = require('./testHelpers');
    const { createFinancialEntry } = require('../src/features/finance/financialEntries.service');

    const { installments } = await issuePolicyWithInstallments(transaction, 1);
    const inst = installments[0];

    // Despesa de OUTRO contexto com exatamente o mesmo valor, liquidada — o cenário do achado.
    const costCenter = await createTestCostCenter(tenant, transaction);
    const intruder = await createFinancialEntry(
      withTenant({
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: Number(inst.amount),
        dueAt: '2030-01-10',
        description: `QA contexto alheio ${uniqueSuffix()}`,
        costCenterId: costCenter.id,
      }),
      tenant.userId,
      transaction
    );
    await settleFinancialEntryWithApproval(tenant, intruder.id, tenant.userId, transaction);

    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(inst.id, intruder.id, actorWithTenant(), transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_LINKED');
        return true;
      },
      'lançamento de outro contexto não pode dar baixa na parcela, mesmo com natureza e valor iguais'
    );
  });
});

test('C5: baixa com o PRÓPRIO lançamento vinculado (liquidado) funciona', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { settleFinancialEntryWithApproval } = require('./testHelpers');

    const { installments } = await issuePolicyWithInstallments(transaction, 1);
    const inst = installments[0];

    await settleFinancialEntryWithApproval(tenant, inst.financialEntryId, tenant.userId, transaction);

    const paid = await insuranceService.payInsurancePolicyInstallment(inst.id, inst.financialEntryId, actorWithTenant(), transaction);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.financialEntryId, inst.financialEntryId);
  });
});

// ---------------------------------------------------------------------------------------------
// RECONF (auditoria Marco 7 "reconf", 18/10/2026) — achados finais da rodada de reconfirmação
// ---------------------------------------------------------------------------------------------

function saoPauloDateOf(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

test('RECONF-1: payable da parcela vence no MESMO dia da parcela em São Paulo (nunca D-1 por fuso)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { installments } = await issuePolicyWithInstallments(transaction, 3);
    assert.equal(installments.length, 3);
    for (const inst of installments) {
      const entry = await FinancialEntry.findByPk(inst.financialEntryId, { transaction });
      assert.equal(
        saoPauloDateOf(entry.dueAt),
        String(inst.dueDate).slice(0, 10),
        `parcela ${inst.dueDate} gerou lançamento vencendo em ${saoPauloDateOf(entry.dueAt)} (America/Sao_Paulo) — perdeu um dia por fuso`
      );
    }
  });
});

test('RECONF-1: parcela com vencimento HOJE não nasce "Vencida" no momento da emissão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const todaySaoPaulo = saoPauloDateOf(new Date());
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 50000 }, actorWithTenant(), transaction);
    await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: todaySaoPaulo, expiryDate: `${Number(todaySaoPaulo.slice(0, 4)) + 1}${todaySaoPaulo.slice(4)}`, installmentsCount: 1 },
      actorWithTenant(),
      transaction
    );
    const [inst] = await insuranceService.listPolicyInstallments(policy.id, tenant.groupId, tenant.companyId, transaction);
    const entry = await FinancialEntry.findByPk(inst.financialEntryId, { transaction });
    assert.equal(saoPauloDateOf(entry.dueAt), todaySaoPaulo);
    // Mesma regra de "Vencida" do Front (lib/mock/finance.js#isEntryOverdue): PENDING e dueAt < agora.
    // Ancorado ao meio-dia de SP: só vence depois das 12:00 do próprio dia, nunca na emissão de
    // madrugada/manhã (antes: meia-noite UTC = 21:00 do dia anterior => "Vencida" ao nascer).
    const nowSaoPauloHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    if (nowSaoPauloHour < 12) {
      assert.ok(new Date(entry.dueAt).getTime() > Date.now(), 'emitida antes do meio-dia, a parcela de hoje não pode nascer vencida');
    }
    assert.ok(new Date(entry.dueAt).getTime() > new Date(`${todaySaoPaulo}T03:00:00Z`).getTime(), 'o vencimento nunca pode cair antes do início do próprio dia em SP');
  });
});

async function overReceiptScenario(transaction, { quantity = 25, received = 30, invoice } = {}) {
  const { item, location } = await createItemAndWarehouse(transaction);
  const { order } = await fullProcurementCycle(transaction, { item, quantity, unitPrice: 4 });
  const { discrepancies } = await procurementService.confirmGoodsReceipt(
    order.id, tenant.groupId, tenant.companyId,
    { destinationLocationId: location.id, invoiceFingerprint: invoice, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: received }] },
    actorOf(),
    transaction
  );
  const overReceipt = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT');
  const resolver = await User.create(
    { name: `QA RECONF resolvedor ${uniqueSuffix()}`, email: `qa-reconf-resolver-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  return { item, location, order, overReceipt, resolver };
}

test('RECONF-3: a listagem de divergências identifica item, fornecedor e NF de cada linha', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoice = `RECONF-NF-${uniqueSuffix()}`;
    const { item, overReceipt } = await overReceiptScenario(transaction, { invoice });
    const rows = await procurementService.listDiscrepancies(tenant.groupId, tenant.companyId, transaction);
    const row = rows.find((r) => r.id === overReceipt.id);
    assert.ok(row, 'a divergência precisa aparecer na listagem');
    assert.equal(row.itemName, item.name, 'a linha precisa dizer QUAL item divergiu');
    assert.equal(row.invoiceNumber, invoice, 'a linha precisa dizer de qual NF veio');
    assert.ok(row.purchaseOrderId, 'a linha precisa apontar o pedido de compra');
    assert.ok('supplierName' in row, 'a linha expõe o fornecedor');
  });
});

test('RECONF-4: rejeitar divergência SEM justificativa é recusado; com justificativa, a trilha da devolução fica na resolução', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { overReceipt, resolver } = await overReceiptScenario(transaction);
    await assert.rejects(
      () => procurementService.resolveDiscrepancy(overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED' }, { userId: resolver.id }, transaction),
      (err) => { assert.equal(err.code, 'RECEIPT_DISCREPANCY_REJECTION_REASON_REQUIRED'); return true; }
    );
    await assert.rejects(
      () => procurementService.resolveDiscrepancy(overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED', notes: '   ' }, { userId: resolver.id }, transaction),
      (err) => { assert.equal(err.code, 'RECEIPT_DISCREPANCY_REJECTION_REASON_REQUIRED'); return true; }
    );
    const resolved = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED', notes: 'Fornecedor levou o excedente de volta.' }, { userId: resolver.id }, transaction
    );
    assert.equal(resolved.status, 'REJECTED');
    assert.match(String(resolved.resolutionNotes), /Fornecedor levou o excedente de volta/);
    assert.match(String(resolved.resolutionNotes), /devolução ao fornecedor/i);
  });
});

test('RECONF-5: quem registrou o recebimento NÃO pode decidir a própria divergência (maker-checker)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { overReceipt, resolver } = await overReceiptScenario(transaction);
    await assert.rejects(
      () => procurementService.resolveDiscrepancy(overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, { userId: tenant.userId }, transaction),
      (err) => { assert.equal(err.code, 'RECEIPT_DISCREPANCY_SELF_RESOLUTION_BLOCKED'); return true; }
    );
    const accepted = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, { userId: resolver.id }, transaction
    );
    assert.equal(accepted.status, 'ACCEPTED', 'outra pessoa com permissão decide normalmente');
  });
});

test('RECONF-6: a entrada de estoque do excedente ACEITO carrega o número da NF do recebimento original', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoice = `RECONF-EXC-${uniqueSuffix()}`;
    const { item, location, overReceipt, resolver } = await overReceiptScenario(transaction, { invoice });
    await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, { userId: resolver.id }, transaction
    );
    const movements = await InventoryMovement.findAll({
      where: { inventoryItemId: item.id, destinationLocationId: location.id, movementType: 'IN' },
      order: [['created_at', 'ASC']],
      transaction,
    });
    assert.equal(movements.length, 2, 'duas entradas: o recebimento capado (25) e o excedente aceito (5)');
    for (const m of movements) {
      assert.match(String(m.reason), new RegExp(`nota fiscal nº ${invoice}`), `toda entrada (inclusive a do excedente) precisa citar a NF — achado: "${m.reason}"`);
    }
  });
});
