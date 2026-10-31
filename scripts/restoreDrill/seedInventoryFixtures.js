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
 *   - Evidência complementar (pedido da cliente, 28/10/2026): empréstimos de ferramenta (1 aberto,
 *     1 devolvido, 1 devolvido danificado que abre a OS de manutenção), caso de perda em análise e
 *     caso de perda decidido (com o movimento LOSS), contagem de inventário fechada com divergência
 *     (+ proposta de ajuste pendente, sem mexer no saldo) e contagem aberta, sinistros de seguro
 *     (aberto, submetido e liquidado com o lançamento no Financeiro) e anexos reais (evidências
 *     de perda, laudo de sinistro, documento da apólice) enviados pelo módulo de arquivos.
 *
 * Uso (só pelo orquestrador): node scripts/restoreDrill/seedInventoryFixtures.js --out <fixtures.json>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertDrillDatabase } = require('./drillGuard');

assertDrillDatabase(process.env.DATABASE_URL, 'seedInventoryFixtures');

const fx = require('../lib/inventoryFixtures');
const { businessDateKey, startOfBusinessDay } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'businessDate'));

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
  // A entrega de material exige a pessoa que retira (responsiblePersonId).
  await T((t) => ctx.requisitionsService.issueRequisition(requisition.id, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, t, { responsiblePersonId: base.retirante.id }));

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

  // ---------------------------------------------------------------------------------------------
  // Evidência complementar: empréstimos, manutenção, perdas, contagens, sinistros e anexos.
  // ---------------------------------------------------------------------------------------------
  const tomador = await fx.createUser(ctx, 'Tomador Ferramenta');
  const attachments = [];
  // Anexo real pelo módulo de arquivos (cifra, antivírus, checksum). O SHA-256 esperado é calculado
  // aqui, de forma independente, a partir dos bytes enviados.
  const upload = (label, text) => T(async (t) => {
    const buf = Buffer.from(`%PDF-1.4\n% ${label}\n${text}\n%%EOF\n`, 'utf8');
    const file = await ctx.filesService.uploadFile({
      groupId: tenant.groupId, companyId: tenant.companyId, fileName: `${label}.pdf`, mimeType: 'application/pdf',
      contentBase64: buf.toString('base64'), category: 'generic',
    }, tenant.userId, t);
    attachments.push({ id: file.id, label, expectedSha256: crypto.createHash('sha256').update(buf).digest('hex'), expectedBytes: buf.length });
    return file;
  });
  const dueAt = businessDateKey(startOfBusinessDay(new Date(), 30));

  // Ferramentas (patrimônio) e empréstimos: aberto, devolvido OK e devolvido danificado (abre a OS).
  const mkTool = (name, tag) => T((t) => ctx.assetsService.createAsset({ groupId: tenant.groupId, companyId: tenant.companyId, name, assetTag: `${tag}-${fx.suffix()}`, acquisitionValue: 1200.4, acquiredAt: '2026-02-10', currentLocationId: base.central.id }, tenant.userId, t));
  const toolOpen = await mkTool('Drill Martelete rompedor', 'DRL-MAR');
  const toolOk = await mkTool('Drill Serra circular', 'DRL-SER');
  const toolBroken = await mkTool('Drill Lixadeira angular', 'DRL-LIX');
  const loanOne = (asset) => T((t) => ctx.toolLoansService.loanTool(asset.id, { personUserId: tomador.id, destinationLocationId: base.filial.id, dueAt, conditionOutCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, t));
  const loanOpen = await loanOne(toolOpen);
  const loanReturned = await loanOne(toolOk);
  await T((t) => ctx.toolLoansService.returnTool(loanReturned.id, { conditionCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, t));
  const loanDamaged = await loanOne(toolBroken);
  const damagedReturn = await T((t) => ctx.toolLoansService.returnTool(loanDamaged.id, { conditionCode: 'DAMAGED' }, tenant.userId, tenant.groupId, tenant.companyId, t));
  if (!damagedReturn.maintenanceOrder) throw new Error('A devolução danificada deveria abrir a ordem de manutenção.');

  // Casos de perda (evidência = arquivo anexado): um em análise e um decidido por outra pessoa.
  const evLossOpen = await upload('evidencia-perda-em-analise', 'Foto/relato: 3 sacos de cimento avariados no almoxarifado central.');
  const evLossDecided = await upload('evidencia-perda-decidida', 'Laudo: 2 barras de vergalhão extraviadas na obra.');
  const lossOpen = await T((t) => ctx.lossCasesService.openLossCase({ groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: base.cimento.id, locationId: base.central.id, quantity: 3, responsiblePersonId: base.retirante.id, context: 'Drill — sacos de cimento avariados por umidade (em análise).', evidenceFileIds: [evLossOpen.id] }, tenant.userId, t));
  const lossToDecide = await T((t) => ctx.lossCasesService.openLossCase({ groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: base.vergalhao.id, locationId: base.central.id, quantity: 2, responsiblePersonId: base.retirante.id, context: 'Drill — vergalhão extraviado na obra (decidido).', evidenceFileIds: [evLossDecided.id] }, tenant.userId, t));
  const lossDecided = await T((t) => ctx.lossCasesService.decideLossCase(lossToDecide.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: approver.id, canApprove: true }, t), approver.id);

  // Contagem fechada com divergência (saldo NÃO é alterado) + proposta de ajuste pendente.
  const countClosed = await T((t) => ctx.countsService.openCount({ groupId: tenant.groupId, companyId: tenant.companyId, locationId: base.central.id }, tenant.userId, t));
  await T((t) => ctx.countsService.addCountItem(countClosed.id, tenant.groupId, tenant.companyId, { inventoryItemId: base.cimento.id, countedQuantity: 170 }, t));
  await T((t) => ctx.countsService.addCountItem(countClosed.id, tenant.groupId, tenant.companyId, { inventoryItemId: base.vergalhao.id, countedQuantity: 90 }, t));
  const closed = await T((t) => ctx.countsService.completeCount(countClosed.id, tenant.groupId, tenant.companyId, tenant.userId, t));
  const diverging = closed.items.filter((l) => Number(l.divergence) !== 0);
  if (diverging.length === 0) throw new Error('A contagem fechada deveria ter divergência.');
  const cimentoLine = closed.items.find((l) => l.inventoryItemId === base.cimento.id);
  const proposal = await T((t) => ctx.movementsApprovalService.proposeAdjustment({
    groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: base.cimento.id, movementType: 'ADJUSTMENT', quantity: Math.abs(Number(cimentoLine.divergence)),
    sourceLocationId: base.central.id, reason: 'Drill — ajuste proposto a partir da divergência da contagem física.', idempotencyKey: `drill-count-adjustment-${countClosed.id}`,
  }, { userId: tenant.userId, canApprove: false }, t));
  // Contagem aberta noutro local (congela só aquele local; por isso vem por último).
  const countOpen = await T((t) => ctx.countsService.openCount({ groupId: tenant.groupId, companyId: tenant.companyId, locationId: base.filial.id }, tenant.userId, t));
  await T((t) => ctx.countsService.addCountItem(countOpen.id, tenant.groupId, tenant.companyId, { inventoryItemId: base.cimento.id, countedQuantity: 33 }, t));

  // Sinistros: aberto, submetido e liquidado (lançamento a receber no Financeiro) + anexos.
  const insActor = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  const claimOpen = await T((t) => ctx.insuranceService.openClaim(policy.id, { description: 'Drill — dano em betoneira (aberto)', claimAmount: 1500.5 }, insActor, t));
  const claimSubmitted = await T(async (t) => {
    const c = await ctx.insuranceService.openClaim(policy.id, { description: 'Drill — furto de ferramentas (submetido)', claimAmount: 3200 }, insActor, t);
    return ctx.insuranceService.submitClaim(c.id, insActor, t);
  });
  const claimToSettle = await T(async (t) => {
    const c = await ctx.insuranceService.openClaim(policy.id, { description: 'Drill — incêndio em almoxarifado (liquidado)', claimAmount: 800.25 }, insActor, t);
    return ctx.insuranceService.submitClaim(c.id, insActor, t);
  });
  const claimSettled = await T((t) => ctx.insuranceService.confirmClaimSettlement(claimToSettle.externalClaimId, 'SETTLED', 800.25, t));
  const evClaim = await upload('laudo-sinistro-liquidado', 'Laudo da seguradora: indenização de R$ 800,25 aprovada.');
  const evPolicy = await upload('apolice-assinada', 'Apólice assinada (via digitalizada).');
  await T(async (t) => {
    await ctx.models.FileLink.create({ groupId: tenant.groupId, companyId: tenant.companyId, fileId: evClaim.id, relatedEntityType: 'InsuranceClaim', relatedEntityId: claimToSettle.id, purpose: 'CLAIM_EVIDENCE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    await ctx.insuranceService.attachPolicyDocument(policy.id, evPolicy.id, insActor, t);
  });

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
    complement: {
      toolLoans: { openId: loanOpen.id, returnedId: loanReturned.id, damagedId: loanDamaged.id },
      maintenanceOrderId: damagedReturn.maintenanceOrder.id,
      lossCases: { analysisId: lossOpen.id, decidedId: lossDecided.id, decidedMovementId: lossDecided.resultingMovementId },
      counts: { closedId: countClosed.id, openId: countOpen.id, divergentItems: diverging.length },
      adjustmentProposalId: proposal.id,
      claims: { openId: claimOpen.id, submittedId: claimSubmitted.id, settledId: claimSettled.id, settledAmount: Number(claimSettled.settledAmount), settledFinancialEntryId: claimSettled.financialEntryId, settledStatus: claimSettled.status },
      attachments,
    },
  };
  fs.writeFileSync(out, JSON.stringify(fixtures, null, 2));
  console.log(`fixtures: 2 itens, 2 locais, 5 movimentos manuais + requisição entregue, pedido ${po.order.id.slice(0, 8)} com 2 recebimentos (divergências: ${fixtures.discrepancyTypes.join(', ') || 'nenhuma'}), apólice ${policy.status}, ${assets.length} ativos; complemento: 3 empréstimos (1 aberto, 2 devolvidos), OS ${damagedReturn.maintenanceOrder.status}, perdas (${lossOpen.status} + ${lossDecided.status}), 2 contagens (${closed.status} com ${diverging.length} divergência(s) + OPEN), proposta de ajuste ${proposal.status}, 3 sinistros (OPEN, SUBMITTED, ${claimSettled.status}), ${attachments.length} anexos.`);
  await ctx.sequelize.close();
}

main().catch(async (err) => {
  console.error(`seedInventoryFixtures falhou: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
