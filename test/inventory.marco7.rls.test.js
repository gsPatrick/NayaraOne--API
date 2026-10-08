'use strict';

// Auditoria de conformidade contratual Marco 7 (2026-10-07) — EST-TS-11 "Cross-company → RLS
// bloqueia", estendido para TODAS as tabelas de Estoque/Patrimônio e Compras (até aqui só
// inventory.assets tinha teste dedicado, em test/inventory.rlsWrite.test.js — este arquivo
// replica exatamente aquele padrão para as demais tabelas).
//
// Para cada tabela: cria a linha pelo service real sob o contexto RLS da empresa A, troca o
// `app.company_id` da MESMA transação para outra empresa (B) e verifica que:
//   1. SELECT não enxerga a linha;
//   2. UPDATE e DELETE afetam 0 linhas;
// depois, de volta à empresa A:
//   3. UPDATE que tenta "mover" a linha para a empresa B (SET company_id = B) é rejeitado pela
//      política (USING da policy tenant_isolation vale como WITH CHECK — erro 42501);
//   4. a linha continua intacta (coluna-alvo com o valor original).
//
// Verificado no catálogo do banco de dev (2026-10-07): o usuário da aplicação é
// `nayara_runtime` (rolsuper=false, rolbypassrls=false) e todas as tabelas inventory.* e
// procurement.* têm ENABLE + FORCE ROW LEVEL SECURITY com a policy `tenant_isolation`
// (company_id = current_setting('app.company_id')). Ou seja, aqui o RLS é exercitado de verdade.
// (Se rodar localmente com um DB_USER superuser, o Postgres ignora RLS e estes testes falham —
// mesma limitação documentada em inventory.rlsWrite.test.js.)
//
// Tudo roda em withRollbackTenantTransaction: nada persiste.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const assetsService = require('../src/features/inventory/assets.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const countsService = require('../src/features/inventory/counts.service');
const procurementService = require('../src/features/procurement/procurement.service');
const filesService = require('../src/features/files/files.service');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  // core.companies também tem RLS por grupo — procura outra empresa real do mesmo grupo; se não
  // houver, usa um UUID aleatório (o efeito no RLS é o mesmo: company_id != empresa da linha).
  const row = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    const [[r]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :c LIMIT 1', {
      replacements: { c: tenant.companyId },
      transaction,
    });
    return r;
  });
  otherCompanyId = row ? row.id : randomUUID();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function setCompany(companyId, transaction) {
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction });
}

/**
 * Prova isolamento cross-tenant de leitura + escrita para uma linha já criada sob a empresa A.
 * `column`/`hostileValue` = coluna que um atacante da empresa B tentaria alterar.
 */
async function assertCrossTenantIsolated(transaction, { table, id, column, hostileValue }) {
  const [[original]] = await sequelize.query(`SELECT company_id, ${column} AS v FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
  assert.ok(original, `${table}: a linha de fixture precisa existir e ser visível para a própria empresa`);
  assert.equal(original.company_id, tenant.companyId);

  await setCompany(otherCompanyId, transaction);
  try {
    const [rows] = await sequelize.query(`SELECT id FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    assert.equal(rows.length, 0, `${table}: SELECT cross-tenant não pode enxergar a linha`);

    const [, upd] = await sequelize.query(`UPDATE ${table} SET ${column} = :v WHERE id = :id`, { replacements: { v: hostileValue, id }, transaction });
    assert.equal(upd.rowCount, 0, `${table}: UPDATE cross-tenant não pode afetar nenhuma linha`);

    const [, del] = await sequelize.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    assert.equal(del.rowCount, 0, `${table}: DELETE cross-tenant não pode afetar nenhuma linha`);
  } finally {
    await setCompany(tenant.companyId, transaction);
  }

  // Tentativa de "sequestrar" a linha para a outra empresa a partir da empresa dona: a nova
  // versão da linha viola a policy → o Postgres precisa rejeitar (42501). Savepoint para não
  // abortar a transação externa.
  let hijackError = null;
  try {
    await sequelize.transaction({ transaction }, async (sp) => {
      await sequelize.query(`UPDATE ${table} SET company_id = :other WHERE id = :id`, { replacements: { other: otherCompanyId, id }, transaction: sp });
    });
  } catch (err) {
    hijackError = err;
  }
  assert.ok(hijackError, `${table}: mover a linha para outra empresa (SET company_id) precisa ser rejeitado pelo RLS`);
  const pgCode = hijackError?.parent?.code || hijackError?.original?.code;
  assert.equal(pgCode, '42501', `${table}: esperado 42501 (new row violates row-level security policy), recebido ${pgCode}: ${hijackError.message}`);

  const [[after]] = await sequelize.query(`SELECT company_id, ${column} AS v FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
  assert.ok(after, `${table}: a linha precisa continuar existindo após as tentativas cross-tenant`);
  assert.equal(after.company_id, tenant.companyId, `${table}: company_id intacto`);
  assert.deepEqual(after.v, original.v, `${table}: coluna "${column}" intacta`);
}

async function firstId(table, fkColumn, fkValue, transaction) {
  const [[row]] = await sequelize.query(`SELECT id FROM ${table} WHERE ${fkColumn} = :v LIMIT 1`, { replacements: { v: fkValue }, transaction });
  assert.ok(row, `fixture: nenhuma linha em ${table} com ${fkColumn}=${fkValue}`);
  return row.id;
}

test('EST-TS-11 RLS Estoque/Patrimônio: leitura e escrita cross-company bloqueadas em todas as tabelas inventory.*', async (t) => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const approver = { userId: tenant.userId, canApprove: true };

    const item = await itemsService.createItem(withTenant({ name: `HOMO QA RLS M7 ${suffix}`, sku: `RLSM7-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `HOMO QA RLS M7 Deposito ${suffix}` }), tenant.userId, transaction);
    const otherLoc = await itemsService.createLocation(withTenant({ name: `HOMO QA RLS M7 Deposito 2 ${suffix}` }), tenant.userId, transaction);

    const movement = await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 20, destinationLocationId: warehouse.id }),
      approver,
      transaction
    );
    const balanceId = await firstId('inventory.stock_balances', 'inventory_item_id', item.id, transaction);

    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: warehouse.id, invoiceNumber: `NF-RLS-${suffix}`, items: [{ inventoryItemId: item.id, quantity: 5, unitCost: 2 }] }),
      tenant.userId,
      transaction
    );
    const receiptItemId = await firstId('inventory.receipt_items', 'receipt_id', receipt.id, transaction);

    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 2 }] }),
      tenant.userId,
      transaction
    );
    const requisitionItemId = await firstId('inventory.requisition_items', 'requisition_id', requisition.id, transaction);

    const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA RLS M7 Asset ${suffix}`, assetTag: `RLSM7-${suffix}`, currentLocationId: warehouse.id }), tenant.userId, transaction);
    const assetMovement = await assetsService.transferAsset(asset.id, { destinationLocationId: otherLoc.id }, tenant.userId, transaction);
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: otherLoc.id }, tenant.userId, transaction);

    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia-rls.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA-RLS').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: item.id, locationId: warehouse.id, quantity: 1, context: 'RLS M7', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );

    const count = await countsService.openCount(withTenant({ locationId: warehouse.id }), tenant.userId, transaction);
    const countItem = await countsService.addCountItem(count.id, { inventoryItemId: item.id, countedQuantity: 3 }, transaction);

    const specs = [
      { table: 'inventory.inventory_movements', id: movement.id, column: 'quantity', hostileValue: 99999 },
      { table: 'inventory.stock_balances', id: balanceId, column: 'quantity_on_hand', hostileValue: 99999 },
      { table: 'inventory.receipts', id: receipt.id, column: 'status', hostileValue: 'CONFIRMED' },
      { table: 'inventory.receipt_items', id: receiptItemId, column: 'quantity', hostileValue: 99999 },
      { table: 'inventory.requisitions', id: requisition.id, column: 'status', hostileValue: 'ISSUED' },
      { table: 'inventory.requisition_items', id: requisitionItemId, column: 'quantity', hostileValue: 99999 },
      { table: 'inventory.tool_loans', id: loan.id, column: 'status', hostileValue: 'RETURNED' },
      { table: 'inventory.loss_cases', id: lossCase.id, column: 'status', hostileValue: 'APPROVED' },
      { table: 'inventory.counts', id: count.id, column: 'status', hostileValue: 'COMPLETED' },
      { table: 'inventory.count_items', id: countItem.id, column: 'counted_quantity', hostileValue: 99999 },
      { table: 'inventory.asset_movements', id: assetMovement.id, column: 'destination_location_id', hostileValue: warehouse.id },
      { table: 'inventory.inventory_items', id: item.id, column: 'name', hostileValue: 'HACKED' },
      { table: 'inventory.locations', id: warehouse.id, column: 'name', hostileValue: 'HACKED' },
      { table: 'inventory.assets', id: asset.id, column: 'status', hostileValue: 'LOST' },
    ];

    for (const spec of specs) {
      await t.test(spec.table, () => assertCrossTenantIsolated(transaction, spec));
    }
  });
});

test('EST-TS-11 RLS Compras: leitura e escrita cross-company bloqueadas em todas as tabelas procurement.* do ciclo de compra', async (t) => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const actor = { userId: tenant.userId, canApprove: true };

    const item = await itemsService.createItem(withTenant({ name: `HOMO QA RLS PROC ${suffix}`, sku: `RLSPROC-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `HOMO QA RLS PROC Deposito ${suffix}` }), tenant.userId, transaction);

    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    // Over-receipt (15 > 10) para também gerar uma receipt_discrepancy.
    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: warehouse.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 15 }] },
      actor,
      transaction
    );
    assert.equal(discrepancies.length, 1, 'fixture: over-receipt gera discrepância');

    const offerItemId = await firstId('procurement.supplier_offer_items', 'supplier_offer_id', offer.id, transaction);
    const goodsReceiptItemId = await firstId('procurement.goods_receipt_items', 'goods_receipt_id', goodsReceipt.id, transaction);

    const specs = [
      { table: 'procurement.purchase_requests', id: request.id, column: 'status', hostileValue: 'REJECTED' },
      { table: 'procurement.purchase_request_items', id: request.items[0].id, column: 'quantity', hostileValue: 99999 },
      { table: 'procurement.quotations', id: quotation.id, column: 'status', hostileValue: 'OPEN' },
      { table: 'procurement.supplier_offers', id: offer.id, column: 'total_amount', hostileValue: 1 },
      { table: 'procurement.supplier_offer_items', id: offerItemId, column: 'unit_price', hostileValue: 0.01 },
      { table: 'procurement.purchase_orders', id: order.id, column: 'status', hostileValue: 'CANCELLED' },
      { table: 'procurement.purchase_order_items', id: order.items[0].id, column: 'quantity', hostileValue: 99999 },
      { table: 'procurement.goods_receipts', id: goodsReceipt.id, column: 'status', hostileValue: 'DRAFT' },
      { table: 'procurement.goods_receipt_items', id: goodsReceiptItemId, column: 'received_quantity', hostileValue: 99999 },
      { table: 'procurement.receipt_discrepancies', id: discrepancies[0].id, column: 'status', hostileValue: 'RESOLVED' },
    ];

    for (const spec of specs) {
      await t.test(spec.table, () => assertCrossTenantIsolated(transaction, spec));
    }
  });
});
