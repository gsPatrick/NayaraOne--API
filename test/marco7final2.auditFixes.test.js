'use strict';

// Auditoria Marco 7 — rodada "final2" (Claude Browser, 18/10/2026, auditoria_marco7final2_local.md):
//   F2-1 — "vencido" é por DATA de calendário em São Paulo: o lançamento que vence hoje não é
//          vencido em nenhum horário de hoje (antes, depois do meio-dia, já contava);
//   F2-3 — a divergência identifica o pedido de compra (data + valor, nunca UUID) e quem recebeu;
//   F2-4 — a nota da divergência aceita sai legível: sem UUID, sem "payable", valor em R$ e
//          quantidade com a unidade do item.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
} = require('./testHelpers');
// Revisão Marco 7 (19/10/2026, B10): adjudicação exige fornecedor qualificado (documento + vigência).
const { createQualifiedSupplier } = require('./procurementTestSupplier');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { getWeeklyHealthReport, countOverdueEntries } = require('../src/features/finance/financialHealthReport.service');
const { startOfBusinessDay, isDueDateOverdue } = require('../src/utils/businessDate');
const procurementService = require('../src/features/procurement/procurement.service');
const itemsService = require('../src/features/inventory/items.service');
const { User, FinancialEntry } = require('../src/models');

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

// Data pura ancorada ao meio-dia de São Paulo (15:00 UTC) — a mesma convenção usada para gravar
// vencimentos (insurance.service#dateOnlyToNoonSaoPauloInstant, Front dateOnlyInputToIso).
function noonSaoPaulo(dateOnly) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 15, 0, 0));
}

async function createPendingPayable(transaction, dueAt) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  return financialEntriesService.createFinancialEntry(
    withTenant({
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 900,
      dueAt,
      description: `F2-1 parcela ${uniqueSuffix()}`,
      costCenterId: costCenter.id,
    }),
    tenant.userId,
    transaction
  );
}

test('F2-1: regra de data — vence hoje não é vencido em nenhum horário de hoje; vira vencido à 00:00 de amanhã (São Paulo)', () => {
  const dueToday = noonSaoPaulo('2031-03-10');
  assert.equal(isDueDateOverdue(dueToday, new Date('2031-03-10T03:00:00Z')), false, '00:00 de hoje em SP');
  assert.equal(isDueDateOverdue(dueToday, new Date('2031-03-10T16:30:00Z')), false, '13:30 em SP — o horário do achado');
  assert.equal(isDueDateOverdue(dueToday, new Date('2031-03-11T02:59:59Z')), false, '23:59:59 em SP — ainda hoje');
  assert.equal(isDueDateOverdue(dueToday, new Date('2031-03-11T03:00:00Z')), true, '00:00 de amanhã em SP');
  assert.equal(startOfBusinessDay(new Date('2031-03-11T01:00:00Z')).toISOString(), '2031-03-10T03:00:00.000Z', '22:00 em SP ainda é dia 10');
});

test('F2-1: contador de vencidas (banco real) — parcela de hoje não conta, a de ontem conta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const afternoonToday = new Date('2031-03-10T16:30:00Z'); // 13:30 em SP, depois do meio-dia
    const before = await countOverdueEntries(transaction, afternoonToday);

    await createPendingPayable(transaction, noonSaoPaulo('2031-03-10'));
    const afterToday = await countOverdueEntries(transaction, afternoonToday);
    assert.equal(afterToday, before, 'lançamento que vence hoje não entra no contador de vencidas');

    await createPendingPayable(transaction, noonSaoPaulo('2031-03-09'));
    const afterYesterday = await countOverdueEntries(transaction, afternoonToday);
    assert.equal(afterYesterday, before + 1, 'lançamento que venceu ontem entra no contador');

    const nextMidnight = new Date('2031-03-11T03:00:00Z');
    const beforeNextDay = await countOverdueEntries(transaction, new Date('2031-03-11T02:59:00Z'));
    const atNextDay = await countOverdueEntries(transaction, nextMidnight);
    assert.equal(atNextDay - beforeNextDay, 1, 'à 00:00 de amanhã a parcela de hoje passa a ser vencida (e só ela)');
  });
});

test('F2-1: relatório de saúde — parcela de hoje fica em "vence em 7 dias", não em vencidos', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const now = new Date('2031-03-10T20:00:00Z'); // 17:00 em SP
    const base = await getWeeklyHealthReport(transaction, { now });
    await createPendingPayable(transaction, noonSaoPaulo('2031-03-10'));
    const after = await getWeeklyHealthReport(transaction, { now });

    assert.equal(after.overdue.payable.count, base.overdue.payable.count, 'não entra em vencidos');
    assert.equal(after.dueNextSevenDays.payable.count, base.dueNextSevenDays.payable.count + 1, 'entra em "vence em 7 dias"');
    assert.equal(after.dueNext30Days.payable.count, base.dueNext30Days.payable.count + 1);
  });
});

async function overReceiptScenario(transaction, { invoice }) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `F2 Cimento ${suffix}`, sku: `F2-${suffix}`, unitOfMeasure: 'SC' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `F2 Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 25 }] }),
    tenant.userId,
    transaction
  );
  const other = await User.create(
    { name: `QA F2 outro ${suffix}`, email: `qa-f2-other-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', other.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId: (await createQualifiedSupplier(tenant, transaction)).supplierPersonId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 6 }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const { discrepancies } = await procurementService.confirmGoodsReceipt(
    order.id, tenant.groupId, tenant.companyId,
    { destinationLocationId: location.id, invoiceFingerprint: invoice, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 30 }] },
    { userId: tenant.userId, canApprove: true },
    transaction
  );
  return { order, other, overReceipt: discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT') };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('F2-3: a divergência identifica o pedido (data e valor, sem UUID), a unidade do item e quem recebeu', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoice = `F2-NF-${uniqueSuffix()}`;
    const { order, overReceipt } = await overReceiptScenario(transaction, { invoice });
    const rows = await procurementService.listDiscrepancies(tenant.groupId, tenant.companyId, transaction);
    const row = rows.find((r) => r.id === overReceipt.id);
    assert.ok(row);
    assert.ok(row.purchaseOrderCreatedAt, 'data de criação do pedido presente');
    assert.equal(Number(row.purchaseOrderAmount), Number(order.committedAmount), 'valor comprometido do pedido presente');
    assert.equal(row.invoiceNumber, invoice);
    assert.equal(row.itemUnit, 'SC');
    assert.equal(row.receivedByUserId, tenant.userId, 'quem registrou o recebimento');
  });
});

test('F2-4: nota da divergência aceita é legível — sem UUID, sem "payable", valor em R$ e quantidade com unidade', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoice = `F2-NF-${uniqueSuffix()}`;
    const { other, overReceipt } = await overReceiptScenario(transaction, { invoice });
    const resolved = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, { userId: other.id }, transaction
    );
    const notes = String(resolved.resolutionNotes || '');
    assert.doesNotMatch(notes, UUID_RE, `nota sem identificador técnico: ${notes}`);
    assert.doesNotMatch(notes, /payable/i, `nota sem o termo em inglês: ${notes}`);
    assert.match(notes, /R\$\s?30,00/, `valor do excedente em R$ (5 SC x R$ 6,00): ${notes}`);
    assert.match(notes, /5 SC/, `quantidade com a unidade do item: ${notes}`);
    assert.match(notes, new RegExp(`NF nº ${invoice}`), `cita a NF: ${notes}`);

    const payable = await FinancialEntry.findOne({
      // Revisão Marco 7 (19/10/2026), B1: o excedente aceito não gera mais um segundo lançamento —
      // o payable ÚNICO do recebimento é reajustado (chave goods-receipt:<id>[:reconciled:<divergência>]).
      where: { idempotencyKey: { [require('sequelize').Op.like]: 'goods-receipt:%' }, description: { [require('sequelize').Op.ne]: null } },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(payable);
    assert.doesNotMatch(payable.description, UUID_RE, `descrição do lançamento sem UUID: ${payable.description}`);
    assert.doesNotMatch(payable.description, /over-receipt|PO item/i);
  });
});

test('F2-4: nota da divergência rejeitada usa a unidade do item', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { other, overReceipt } = await overReceiptScenario(transaction, { invoice: `F2-NF-${uniqueSuffix()}` });
    const resolved = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED', notes: 'Fornecedor levou de volta.' }, { userId: other.id }, transaction
    );
    assert.match(String(resolved.resolutionNotes), /excedente de 5 SC rejeitado/);
    assert.match(String(resolved.resolutionNotes), /devolução ao fornecedor/);
  });
});

test('F2-2: apólice listada e detalhada já traz o nome do imóvel, do contrato e do segurado (a tela não precisa do Jurídico)', async () => {
  const insuranceService = require('../src/features/procurement/insurance.service');
  const { Contract, Person, Property } = require('../src/models');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const property = await Property.create(
      withTenant({ title: `F2 Loja ${suffix}`, internalCode: `F2-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const contract = await Contract.create(
      withTenant({ contractType: 'LEASE', contractNumber: `F2-CT-${suffix}`, status: 'ACTIVE', propertyId: property.id, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const insured = await Person.create(
      withTenant({ personType: 'PF', legalName: `F2 Segurado ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const policy = await insuranceService.createPolicy(
      withTenant({ coverageSummary: `F2 incêndio ${suffix}`, propertyId: property.id, contractId: contract.id, parties: [{ personId: insured.id, partyRole: 'INSURED' }] }),
      tenant.userId,
      transaction
    );

    const listed = (await insuranceService.listPolicies({}, tenant.groupId, tenant.companyId, transaction)).find((p) => p.id === policy.id).toJSON();
    assert.equal(listed.linkedProperty.title, property.title);
    assert.equal(listed.linkedContract.contractNumber, contract.contractNumber);
    assert.equal(listed.linkedContract.propertyTitle, property.title);
    assert.equal(listed.parties[0].personName, insured.legalName);

    const detail = (await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction)).toJSON();
    assert.equal(detail.linkedContract.contractNumber, contract.contractNumber);
    assert.equal(detail.parties[0].personName, insured.legalName);
  });
});
