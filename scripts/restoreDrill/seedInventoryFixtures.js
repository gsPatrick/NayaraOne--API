'use strict';

/**
 * Fixtures do drill de restore de Estoque/Compras/Seguros/Patrimônio (Marco 7, DoD "restore
 * verdes"). Tudo pelos serviços reais, como a role de runtime (RLS real), só num banco "drill_*"
 * local (drillGuard). Cobre:
 *   - Estoque: 2 itens, 2 almoxarifados, entradas, transferência, saída com responsável e
 *     requisição de material aprovada por outra pessoa e entregue (saída por requisição);
 *   - Compras: pedido pelo fluxo completo, recebimento PARCIAL com NF (payable), recebimento com
 *     excedente (divergência OVER_RECEIPT aberta) e NF com valor divergente (PRICE_MISMATCH);
 *   - Seguros: apólice cotada e emitida (parcelas geradas);
 *   - Patrimônio: 2 ativos (um ligado ao almoxarifado).
 *
 * Uso (só pelo orquestrador): node scripts/restoreDrill/seedInventoryFixtures.js --out <fixtures.json>
 */

const fs = require('fs');
const { assertDrillDatabase } = require('./drillGuard');

assertDrillDatabase(process.env.DATABASE_URL, 'seedInventoryFixtures');

const fx = require('../lib/inventoryFixtures');

async function main() {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  const ctx = fx.load();
  const tenant = await fx.getSeedTenant(ctx);
  const approver = await fx.createUser(ctx, 'Aprovador Estoque');
  const T = (fn, userId) => fx.inTenant(ctx, tenant, fn, userId);

  const base = await T(async (t) => {
    const cimento = await fx.createItem(ctx, tenant, t, 'Drill Cimento CP-II 50kg');
    const vergalhao = await fx.createItem(ctx, tenant, t, 'Drill Vergalhão 10mm');
    const central = await fx.createWarehouse(ctx, tenant, t, 'Drill Almoxarifado Central');
    const filial = await fx.createWarehouse(ctx, tenant, t, 'Drill Almoxarifado Filial');
    const retirante = await fx.createPerson(ctx, tenant, t, 'Drill Encarregado Retirante', 'PF');
    const fornecedor = await fx.createPerson(ctx, tenant, t, 'Drill Fornecedor de Materiais Ltda');
    await fx.move(ctx, tenant, t, { inventoryItemId: cimento.id, movementType: 'IN', quantity: 120, destinationLocationId: central.id, reason: 'Saldo inicial drill' });
    await fx.move(ctx, tenant, t, { inventoryItemId: vergalhao.id, movementType: 'IN', quantity: 75.5, destinationLocationId: central.id, reason: 'Saldo inicial drill' });
    await fx.move(ctx, tenant, t, { inventoryItemId: cimento.id, movementType: 'TRANSFER', quantity: 40, sourceLocationId: central.id, destinationLocationId: filial.id, reason: 'Transferência drill' });
    await fx.move(ctx, tenant, t, { inventoryItemId: cimento.id, movementType: 'OUT', quantity: 12, sourceLocationId: central.id, responsiblePersonId: retirante.id, reason: 'Saída drill' });
    await fx.move(ctx, tenant, t, { inventoryItemId: vergalhao.id, movementType: 'OUT', quantity: 5.25, sourceLocationId: central.id, responsiblePersonId: retirante.id, reason: 'Saída drill' });
    return { cimento, vergalhao, central, filial, retirante, fornecedor };
  });

  // Requisição de material: criada pelo admin, aprovada por outra pessoa, entregue.
  const requisition = await T((t) => ctx.requisitionsService.createRequisition(
    { groupId: tenant.groupId, companyId: tenant.companyId, warehouseLocationId: base.filial.id, items: [{ inventoryItemId: base.cimento.id, quantity: 7 }] },
    tenant.userId, t
  ));
  await T((t) => ctx.requisitionsService.decideRequisition(requisition.id, 'APPROVED', approver.id, tenant.groupId, tenant.companyId, t), approver.id);
  await T((t) => ctx.requisitionsService.issueRequisition(requisition.id, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, t));

  // Compras: pedido com 2 linhas; recebimento parcial com NF; depois excedente na linha 1 e
  // NF com valor divergente.
  const po = await T((t) => fx.createOpenPurchaseOrder(ctx, tenant, t, {
    supplierPersonId: base.fornecedor.id,
    approverId: approver.id,
    lines: [
      { inventoryItemId: base.cimento.id, description: 'Cimento CP-II 50kg', quantity: 100, unitPrice: 38.9 },
      { inventoryItemId: base.vergalhao.id, description: 'Vergalhão 10mm', quantity: 50, unitPrice: 52.35 },
    ],
  }));
  const actor = { userId: tenant.userId, canApprove: false };
  const r1 = await T((t) => ctx.procurementService.confirmGoodsReceipt(po.order.id, tenant.groupId, tenant.companyId, {
    destinationLocationId: base.central.id, invoiceFingerprint: 'DRILL-NF-0001', invoiceTotalAmount: 60 * 38.9,
    idempotencyKey: 'drill-receipt-1', items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 60 }],
  }, actor, t));
  const r2 = await T((t) => ctx.procurementService.confirmGoodsReceipt(po.order.id, tenant.groupId, tenant.companyId, {
    destinationLocationId: base.central.id, invoiceFingerprint: 'DRILL-NF-0002', invoiceTotalAmount: 2000,
    idempotencyKey: 'drill-receipt-2', items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 45 }, { purchaseOrderItemId: po.items[1].id, receivedQuantity: 20 }],
  }, actor, t));

  // Seguros: apólice cotada e emitida → parcelas.
  const policy = await T(async (t) => {
    const p = await ctx.insuranceService.createPolicy({ groupId: tenant.groupId, companyId: tenant.companyId }, tenant.userId, t);
    await ctx.insuranceService.quotePolicy(p.id, { estimatedValue: 250000 }, { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, t);
    return ctx.insuranceService.issuePolicy(p.id, { effectiveDate: '2026-10-01', expiryDate: '2027-10-01' }, { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, t);
  });

  // Patrimônio.
  const assets = await T(async (t) => [
    await ctx.assetsService.createAsset({ groupId: tenant.groupId, companyId: tenant.companyId, name: 'Drill Betoneira 400L', assetTag: `DRL-BET-${fx.suffix()}`, acquisitionValue: 4890.5, acquiredAt: '2026-01-15', currentLocationId: base.central.id }, tenant.userId, t),
    await ctx.assetsService.createAsset({ groupId: tenant.groupId, companyId: tenant.companyId, name: 'Drill Furadeira de impacto', assetTag: `DRL-FUR-${fx.suffix()}`, acquisitionValue: 789.9, acquiredAt: '2026-03-02' }, tenant.userId, t),
  ]);

  const fixtures = {
    tenant,
    itemIds: [base.cimento.id, base.vergalhao.id],
    locationIds: [base.central.id, base.filial.id],
    requisitionId: requisition.id,
    purchaseOrderId: po.order.id,
    goodsReceiptIds: [r1.goodsReceipt.id, r2.goodsReceipt.id],
    discrepancyTypes: r2.discrepancies.map((d) => d.discrepancyType).sort(),
    policyId: policy.id,
    assetIds: assets.map((a) => a.id),
  };
  fs.writeFileSync(out, JSON.stringify(fixtures, null, 2));
  console.log(`fixtures: 2 itens, 2 locais, 5 movimentos manuais + requisição entregue, pedido ${po.order.id.slice(0, 8)} com 2 recebimentos (divergências: ${fixtures.discrepancyTypes.join(', ') || 'nenhuma'}), apólice ${policy.status}, ${assets.length} ativos.`);
  await ctx.sequelize.close();
}

main().catch(async (err) => {
  console.error(`seedInventoryFixtures falhou: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
