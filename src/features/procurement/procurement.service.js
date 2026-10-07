'use strict';

const {
  PurchaseRequest,
  PurchaseRequestItem,
  Quotation,
  SupplierOffer,
  SupplierOfferItem,
  PurchaseOrder,
  PurchaseOrderItem,
  GoodsReceipt,
  GoodsReceiptItem,
  ReceiptDiscrepancy,
  SupplierEvaluation,
  SupplierQualification,
} = require('../../models');
const { InventoryStockBalance, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { confirmReceipt: confirmInventoryReceipt, createReceipt: createInventoryReceipt } = require('../inventory/receipts.service');
const { createFinancialEntry } = require('../finance/financialEntries.service');

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// Tolerância de 1 centavo pra diferença de arredondamento entre soma de linhas e total da NF —
// mesmo espírito de `generateInstallments`/`confirmClaimSettlement` já usados no projeto.
const INVOICE_AMOUNT_TOLERANCE = 0.01;

// Caderno "COMPRAS/PROCUREMENT": REQUEST -> APPROVAL -> RFQ -> COMPARISON -> AWARD -> PO ->
// RECEIPT -> MATCH -> PAYABLE. PO = committed cost (contabilizado só como compromisso, nunca
// lançado no Financeiro aqui — isso é escopo de Financeiro); receipt = Estoque (reusa
// inventory.receipts, nunca duplica a baixa física); invoice match = three-way match PO x
// goods_receipt_item x valor recebido, abre ReceiptDiscrepancy quando não bate.

// --- 1. REQUEST ---
async function createPurchaseRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, projectId, notes, items } = payload;
  if (!groupId || !companyId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "items" (não vazio) são obrigatórios.', 'PURCHASE_REQUEST_VALIDATION');
  }
  for (const line of items) {
    if (!line.description || line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "description" e "quantity" > 0.', 'PURCHASE_REQUEST_VALIDATION');
    }
  }

  const request = await PurchaseRequest.create(
    { groupId, companyId, projectId: projectId || null, notes: notes || null, status: 'REQUESTED', requestedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );

  // Caderno Operacional §34: nova requisição de compra deve verificar estoque existente antes
  // de abrir, pra evitar compra duplicada do que já há em almoxarifado. Implementado como
  // AVISO (não bloqueio) — pode haver motivo legítimo de comprar mesmo com saldo existente
  // (ex.: já reservado para outro projeto), mesma lógica de "NAY sugere, nunca decide"
  // (EST-013) aplicada aqui a uma checagem automática de sistema.
  const stockWarnings = [];
  for (const line of items) {
    await PurchaseRequestItem.create(
      { groupId, companyId, purchaseRequestId: request.id, inventoryItemId: line.inventoryItemId || null, description: line.description, quantity: line.quantity },
      { transaction }
    );
    if (line.inventoryItemId) {
      const balances = await InventoryStockBalance.findAll({ where: { inventoryItemId: line.inventoryItemId }, transaction });
      const totalOnHand = balances.reduce((sum, b) => sum + Number(b.quantityOnHand), 0);
      if (totalOnHand >= Number(line.quantity)) {
        stockWarnings.push({ inventoryItemId: line.inventoryItemId, description: line.description, requestedQuantity: line.quantity, availableQuantity: totalOnHand });
      }
    }
  }
  await registrarAuditoria({ groupId, companyId, actorUserId, action: 'PURCHASE_REQUEST_CREATED', entityType: 'PurchaseRequest', entityId: request.id, reason: 'Requisição de compra criada.' }, transaction);

  const created = await getPurchaseRequest(request.id, transaction);
  return { ...created.toJSON(), stockWarnings };
}

async function getPurchaseRequest(id, transaction) {
  const request = await PurchaseRequest.findByPk(id, { include: [{ model: PurchaseRequestItem, as: 'items' }], transaction });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  return request;
}

async function listPurchaseRequests(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return PurchaseRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// --- 2. APPROVAL ---
async function decidePurchaseRequest(id, decision, actorUserId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'PURCHASE_REQUEST_VALIDATION');
  }
  const request = await PurchaseRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'REQUESTED') {
    throw AppError.badRequest(`Só é possível decidir uma requisição em REQUESTED (atual: ${request.status}).`, 'PURCHASE_REQUEST_INVALID_TRANSITION');
  }
  request.status = decision;
  request.approvedByUserId = actorUserId || null;
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });
  return request;
}

// --- 3. RFQ ---
async function createQuotation(purchaseRequestId, actorUserId, transaction) {
  const request = await PurchaseRequest.findByPk(purchaseRequestId, { transaction });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'APPROVED') {
    throw AppError.badRequest('Só é possível abrir cotação para uma requisição APPROVED.', 'QUOTATION_INVALID_SOURCE');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 5): toda chamada criava uma Quotation
  // nova, mesmo já existindo uma OPEN para a mesma requisição — ao reabrir a tela (reload,
  // nova sessão), as ofertas já submetidas na quotation antiga ficavam órfãs (vinculadas a um
  // quotationId que a UI nunca mais consultava) e sumiam da comparação. Reaproveita a OPEN
  // existente em vez de criar outra (idempotente por requisição).
  const existing = await Quotation.findOne({ where: { purchaseRequestId: request.id, status: 'OPEN' }, transaction });
  if (existing) return existing;
  return Quotation.create(
    { groupId: request.groupId, companyId: request.companyId, purchaseRequestId: request.id, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
}

async function submitSupplierOffer(quotationId, payload, transaction) {
  const { supplierPersonId, items } = payload;
  if (!supplierPersonId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"supplierPersonId" e "items" (não vazio) são obrigatórios.', 'SUPPLIER_OFFER_VALIDATION');
  }
  const quotation = await Quotation.findByPk(quotationId, { transaction });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  if (quotation.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível submeter oferta para uma cotação OPEN (atual: ${quotation.status}).`, 'QUOTATION_INVALID_TRANSITION');
  }

  let totalAmount = 0;
  const offer = await SupplierOffer.create(
    { groupId: quotation.groupId, companyId: quotation.companyId, quotationId: quotation.id, supplierPersonId, status: 'RECEIVED' },
    { transaction }
  );
  for (const line of items) {
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 58, 2026-10-06): o guard usava
    // `Number(unitPrice) < 0`, falso para NaN — um payload com unitPrice:"NaN" passava (Postgres
    // NUMERIC aceita o literal 'NaN'), corrompendo totalAmount/committedAmount do PO adjudicado.
    if (!line.purchaseRequestItemId || line.unitPrice == null || !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0) {
      throw AppError.badRequest('Cada item precisa de "purchaseRequestItemId" e "unitPrice" >= 0.', 'SUPPLIER_OFFER_VALIDATION');
    }
    const prItem = await PurchaseRequestItem.findByPk(line.purchaseRequestItemId, { transaction });
    if (!prItem) throw AppError.notFound(`Item de requisição "${line.purchaseRequestItemId}" não encontrado.`, 'PURCHASE_REQUEST_ITEM_NOT_FOUND');
    await SupplierOfferItem.create(
      { groupId: quotation.groupId, companyId: quotation.companyId, supplierOfferId: offer.id, purchaseRequestItemId: line.purchaseRequestItemId, unitPrice: line.unitPrice },
      { transaction }
    );
    totalAmount += Number(line.unitPrice) * Number(prItem.quantity);
  }
  offer.totalAmount = totalAmount;
  await offer.save({ transaction });
  return offer;
}

// --- 4. COMPARISON (read-only) ---
async function compareOffers(quotationId, transaction) {
  const quotation = await Quotation.findByPk(quotationId, {
    include: [{ model: SupplierOffer, as: 'offers', include: [{ model: SupplierOfferItem, as: 'items' }] }],
    transaction,
  });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  const offers = quotation.offers.slice().sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 61, 2026-10-06): compareOffers nunca
  // incluía o nome do fornecedor — a tela de comparação de ofertas (/painel/compras) mostrava
  // supplierPersonId cru (UUID), sem forma de saber quem está ofertando (Categoria 6 do catálogo
  // de bugs). SupplierOffer não tem FK Sequelize pra Person (schema cruzado procurement/people,
  // mesmo padrão de constraints:false usado no resto do módulo), então busca-se separado.
  const supplierIds = [...new Set(offers.map((o) => o.supplierPersonId).filter(Boolean))];
  const nameById = new Map();
  if (supplierIds.length > 0) {
    const people = await Person.findAll({ where: { id: supplierIds }, attributes: ['id', 'legalName'], transaction });
    for (const p of people) nameById.set(p.id, p.legalName);
  }

  // `supplierPersonName` não é atributo declarado no model — sem instância plain (toJSON), o
  // JSON.stringify da resposta HTTP (via res.json -> Model.toJSON -> get({plain:true})) IGNORA
  // qualquer propriedade atribuída diretamente na instância Sequelize, nunca chegando ao front.
  return offers.map((offer) => ({ ...offer.toJSON(), supplierPersonName: nameById.get(offer.supplierPersonId) || null }));
}

// --- 5. AWARD -> 6. PO ---
async function awardSupplierOffer(offerId, actorUserId, transaction) {
  // Postgres rejeita FOR UPDATE combinado com include de hasMany (outer join nullable) — lock
  // só na linha da oferta; os itens (imutáveis após submissão) são lidos separadamente.
  const offer = await SupplierOffer.findByPk(offerId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!offer) throw AppError.notFound('Oferta de fornecedor não encontrada.', 'SUPPLIER_OFFER_NOT_FOUND');
  if (offer.status !== 'RECEIVED') {
    throw AppError.badRequest(`Só é possível adjudicar uma oferta RECEIVED (atual: ${offer.status}).`, 'SUPPLIER_OFFER_INVALID_TRANSITION');
  }
  offer.items = await SupplierOfferItem.findAll({ where: { supplierOfferId: offer.id }, transaction });
  const quotation = await Quotation.findByPk(offer.quotationId, { transaction, lock: transaction.LOCK.UPDATE });
  const request = await PurchaseRequest.findByPk(quotation.purchaseRequestId, { transaction, lock: transaction.LOCK.UPDATE });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 57, 2026-10-06): awardSupplierOffer só
  // validava o status da SupplierOffer, nunca o da Quotation — uma cotação com 2+ ofertas RECEIVED
  // podia ser adjudicada duas vezes (a oferta vencedora muda de status, mas as outras continuam
  // RECEIVED e passam pela única guarda existente), gerando múltiplos PurchaseOrder concorrentes
  // para a mesma PurchaseRequest e duplicando o custo comprometido.
  if (quotation.status !== 'OPEN') {
    throw AppError.conflict('Esta cotação já foi adjudicada.', 'QUOTATION_ALREADY_AWARDED');
  }

  // Contrato (Anexo I, "Fornecedores: documentos/vigência; due diligence para alto risco") —
  // fornecedor marcado como alto risco só pode ser adjudicado com due diligence APPROVED e
  // ainda dentro da vigência (validUntil). Fail-closed: sem registro de qualificação nenhum,
  // trata como ainda não qualificado (nunca assume "ok" por omissão).
  const qualification = await SupplierQualification.findOne({
    where: { companyId: offer.companyId, supplierPersonId: offer.supplierPersonId },
    transaction,
  });
  if (qualification?.highRisk) {
    const expired = qualification.validUntil && new Date(qualification.validUntil) < new Date();
    if (qualification.dueDiligenceStatus !== 'APPROVED' || expired) {
      throw AppError.badRequest(
        'Fornecedor de alto risco precisa de due diligence aprovada e dentro da vigência antes de receber uma PO.',
        'SUPPLIER_DUE_DILIGENCE_REQUIRED'
      );
    }
  }

  const order = await PurchaseOrder.create(
    {
      groupId: offer.groupId,
      companyId: offer.companyId,
      purchaseRequestId: request.id,
      supplierOfferId: offer.id,
      supplierPersonId: offer.supplierPersonId,
      status: 'OPEN',
      committedAmount: offer.totalAmount,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  for (const offerItem of offer.items) {
    const prItem = await PurchaseRequestItem.findByPk(offerItem.purchaseRequestItemId, { transaction });
    await PurchaseOrderItem.create(
      {
        groupId: offer.groupId,
        companyId: offer.companyId,
        purchaseOrderId: order.id,
        inventoryItemId: prItem.inventoryItemId,
        description: prItem.description,
        quantity: prItem.quantity,
        unitPrice: offerItem.unitPrice,
      },
      { transaction }
    );
  }

  offer.status = 'AWARDED';
  await offer.save({ transaction });
  quotation.status = 'CLOSED';
  await quotation.save({ transaction });
  request.status = 'AWARDED';
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId, action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: order.id, reason: `PO gerada a partir da oferta ${offer.id} — custo comprometido ${order.committedAmount}.` }, transaction);

  return getPurchaseOrder(order.id, transaction);
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 62, 2026-10-06): PurchaseOrder só tem
// supplierPersonId (sem FK Sequelize pra Person, schema cruzado procurement/people) — a tela de
// Pedidos de Compra mostrava o UUID cru na coluna "Fornecedor" (mesma Categoria 6 do catálogo já
// corrigida em compareOffers na rodada 61, um passo adiante no funil).
async function attachSupplierPersonNames(orders, transaction) {
  const supplierIds = [...new Set(orders.map((o) => o.supplierPersonId).filter(Boolean))];
  const nameById = new Map();
  if (supplierIds.length > 0) {
    const people = await Person.findAll({ where: { id: supplierIds }, attributes: ['id', 'legalName'], transaction });
    for (const p of people) nameById.set(p.id, p.legalName);
  }
  return orders.map((order) => ({ ...order.toJSON(), supplierPersonName: nameById.get(order.supplierPersonId) || null }));
}

async function getPurchaseOrder(id, transaction) {
  const order = await PurchaseOrder.findByPk(id, { include: [{ model: PurchaseOrderItem, as: 'items' }], transaction });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  const [withName] = await attachSupplierPersonNames([order], transaction);
  return withName;
}

async function listPurchaseOrders(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  const orders = await PurchaseOrder.findAll({ where, order: [['created_at', 'DESC']], transaction });
  return attachSupplierPersonNames(orders, transaction);
}

// --- 7. RECEIPT -> 8. MATCH ---
// EST-TS/Caderno "goods_receipts": over-receipt/invoice sem receipt tratados aqui. O recebimento
// FÍSICO real é delegado a inventory.receipts (nunca duplicamos a lógica de IN/saldo) — este
// serviço só cria o receipt de inventário com os itens do PO e abre discrepâncias.
async function confirmGoodsReceipt(purchaseOrderId, payload, actor, transaction) {
  const { destinationLocationId, invoiceFingerprint, invoiceTotalAmount, items, idempotencyKey } = payload;
  if (!destinationLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"destinationLocationId" e "items" (não vazio) são obrigatórios.', 'GOODS_RECEIPT_VALIDATION');
  }

  if (invoiceFingerprint) {
    const existing = await GoodsReceipt.findOne({ where: { invoiceFingerprint }, transaction });
    if (existing) throw AppError.badRequest(`Já existe um recebimento (${existing.id}) com esta mesma nota fiscal.`, 'GOODS_RECEIPT_DUPLICATE_INVOICE');
  }

  const order = await PurchaseOrder.findByPk(purchaseOrderId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  if (order.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível receber um PO OPEN (atual: ${order.status}).`, 'PURCHASE_ORDER_INVALID_TRANSITION');
  }
  order.items = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 64, 2026-10-06): a única proteção
  // real contra duplo-processamento era o status do PO virar != OPEN, que só acontece no
  // recebimento TOTAL — em recebimento PARCIAL (PO continua OPEN), um retry de rede com o mesmo
  // payload criava um segundo GoodsReceipt + segundo FinancialEntry duplicado (a idempotencyKey
  // antiga usada no payable era derivada de goodsReceipt.id, gerado DENTRO desta própria
  // chamada — nunca podia colidir, não protegia nada). Chave opcional do cliente, mesmo padrão
  // de transferAsset/AssetMovement — se já processado, retorna o recebimento existente.
  if (idempotencyKey) {
    const existingByKey = await GoodsReceipt.findOne({ where: { companyId: order.companyId, idempotencyKey }, transaction });
    if (existingByKey) {
      const existingDiscrepancies = await ReceiptDiscrepancy.findAll({
        where: { goodsReceiptItemId: (await GoodsReceiptItem.findAll({ where: { goodsReceiptId: existingByKey.id }, attributes: ['id'], transaction })).map((i) => i.id) },
        transaction,
      });
      return { goodsReceipt: existingByKey, discrepancies: existingDiscrepancies };
    }
  }

  const goodsReceipt = await GoodsReceipt.create(
    { groupId: order.groupId, companyId: order.companyId, purchaseOrderId: order.id, destinationLocationId, invoiceFingerprint: invoiceFingerprint || null, invoiceTotalAmount: invoiceTotalAmount != null ? invoiceTotalAmount : null, idempotencyKey: idempotencyKey || null, status: 'DRAFT', createdBy: actor.userId || null, updatedBy: actor.userId || null },
    { transaction }
  );

  const inventoryReceiptItems = [];
  const discrepancies = [];
  let firstGrItem = null;
  let expectedAmount = 0;

  for (const line of items) {
    const poItem = order.items.find((i) => i.id === line.purchaseOrderItemId);
    if (!poItem) throw AppError.notFound(`Item de PO "${line.purchaseOrderItemId}" não encontrado.`, 'PURCHASE_ORDER_ITEM_NOT_FOUND');

    const receivedQty = Number(line.receivedQuantity);
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): nenhuma validação
    // de sinal/numérico em receivedQuantity — um valor negativo decrementava poItem.receivedQuantity
    // silenciosamente (sem disparar discrepância, já que `receivedQty > remaining` nunca é true para
    // negativo) e sem reverter estoque (guard `receivedQty > 0` abaixo impede o item de estoque),
    // desalinhando permanentemente o saldo recebido do PO vs. o estoque real.
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      throw AppError.badRequest(`"receivedQuantity" do item "${line.purchaseOrderItemId}" deve ser um número maior que zero.`, 'GOODS_RECEIPT_INVALID_QUANTITY');
    }
    const remaining = Number(poItem.quantity) - Number(poItem.receivedQuantity);
    expectedAmount += receivedQty * Number(poItem.unitPrice);

    const grItem = await GoodsReceiptItem.create(
      { groupId: order.groupId, companyId: order.companyId, goodsReceiptId: goodsReceipt.id, purchaseOrderItemId: poItem.id, receivedQuantity: receivedQty },
      { transaction }
    );
    if (!firstGrItem) firstGrItem = grItem;

    // EST-TS/Three-way match: recebido > saldo restante do PO = over-receipt (OVER_RECEIPT).
    if (receivedQty > remaining) {
      discrepancies.push(
        await ReceiptDiscrepancy.create(
          { groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: grItem.id, discrepancyType: 'OVER_RECEIPT', expectedValue: remaining, receivedValue: receivedQty, status: 'OPEN' },
          { transaction }
        )
      );
    }

    poItem.receivedQuantity = Number(poItem.receivedQuantity) + receivedQty;
    await poItem.save({ transaction });

    if (poItem.inventoryItemId && receivedQty > 0) {
      inventoryReceiptItems.push({ inventoryItemId: poItem.inventoryItemId, quantity: receivedQty, unitCost: poItem.unitPrice });
    }
  }
  expectedAmount = round2(expectedAmount);

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 25, 2026-10-05): o contrato exige
  // three-way match "PO x receipt x invoice" — mas só existia PO x receipt (quantidade). Quando
  // o valor da nota fiscal é informado e diverge do valor esperado (soma unitPrice x
  // receivedQty de todas as linhas), abre uma divergência de PREÇO de verdade, no mesmo padrão
  // fail-closed de OVER_RECEIPT, em vez de aceitar silenciosamente qualquer valor de nota.
  if (invoiceTotalAmount != null && Math.abs(round2(invoiceTotalAmount) - expectedAmount) > INVOICE_AMOUNT_TOLERANCE) {
    discrepancies.push(
      await ReceiptDiscrepancy.create(
        { groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: firstGrItem.id, discrepancyType: 'PRICE_MISMATCH', expectedValue: expectedAmount, receivedValue: round2(invoiceTotalAmount), status: 'OPEN' },
        { transaction }
      )
    );
  }

  // Delega a baixa física real a inventory.receipts — nunca duplica a lógica de IN/saldo/custo.
  if (inventoryReceiptItems.length > 0) {
    const inventoryReceipt = await createInventoryReceipt(
      { groupId: order.groupId, companyId: order.companyId, destinationLocationId, invoiceFingerprint: invoiceFingerprint ? `${invoiceFingerprint}:po:${order.id}` : null, items: inventoryReceiptItems },
      actor.userId,
      transaction
    );
    const { reviewReceipt } = require('../inventory/receipts.service');
    await reviewReceipt(inventoryReceipt.id, actor.userId, transaction);
    await confirmInventoryReceipt(inventoryReceipt.id, actor, transaction);
    goodsReceipt.inventoryReceiptId = inventoryReceipt.id;
  }

  const allItemsFullyReceived = order.items.every((i) => Number(i.receivedQuantity) >= Number(i.quantity));
  order.status = allItemsFullyReceived ? 'RECEIVED' : 'OPEN';
  order.updatedBy = actor.userId || null;
  await order.save({ transaction });

  goodsReceipt.status = 'CONFIRMED';
  goodsReceipt.updatedBy = actor.userId || null;

  // BUG REAL CORRIGIDO (rodada 25): "invoice match = payable idempotente" era descrito no
  // comentário do fluxo (linha ~20 deste arquivo: "RECEIPT -> MATCH -> PAYABLE") mas nunca
  // implementado — nenhum lançamento financeiro era criado a partir do recebimento confirmado.
  // Usa o valor da nota fiscal quando informado (mais preciso — é o que a fornecedora cobra de
  // fato), senão o valor esperado calculado (PO x quantidade recebida). idempotencyKey por
  // goodsReceipt garante que reprocessar nunca duplica o payable.
  const payableAmount = invoiceTotalAmount != null ? round2(invoiceTotalAmount) : expectedAmount;
  if (payableAmount > 0) {
    const payable = await createFinancialEntry(
      {
        groupId: order.groupId,
        companyId: order.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: payableAmount,
        description: `Recebimento de materiais — PO ${order.id}${invoiceFingerprint ? ` (NF ${invoiceFingerprint})` : ''}.`,
        idempotencyKey: `goods-receipt:${goodsReceipt.id}`,
      },
      actor.userId,
      transaction
    );
    goodsReceipt.financialEntryId = payable.id;
  }
  await goodsReceipt.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId: actor.userId, action: 'GOODS_RECEIPT_CONFIRMED', entityType: 'GoodsReceipt', entityId: goodsReceipt.id, reason: `Recebimento confirmado — ${discrepancies.length} divergência(s).` }, transaction);

  return { goodsReceipt, discrepancies };
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 27, 2026-10-05): confirmGoodsReceipt
// cria o GoodsReceipt (com invoiceTotalAmount/financialEntryId, R25/R26), mas não existia
// NENHUM endpoint pra listar/consultar recebimentos depois — o front não tinha como mostrar o
// payable gerado nem o histórico de recebimentos de um PO, mesmo o dado estando correto no
// banco (mesma família de bug da R24, mas "não exposto" em vez de "não exibido").
async function listGoodsReceipts(transaction, { purchaseOrderId } = {}) {
  const where = {};
  if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;
  return GoodsReceipt.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function listDiscrepancies(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return ReceiptDiscrepancy.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

const DISCREPANCY_RESOLUTIONS = ['ACCEPTED', 'REJECTED'];

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 12, 2026-10-05): o contrato diz que
// o three-way match "divergência abre case" — mas nada no sistema jamais fechava esse case.
// `status` tinha DEFAULT 'OPEN' na migration/model exatamente pra existir uma transição, só
// que nenhum serviço/endpoint fazia essa escrita. Mesma família de bug de R7/R9/R10/R11
// ("tabela/campo criado mas nunca manipulado depois da escrita inicial").
async function resolveDiscrepancy(discrepancyId, payload, actor, transaction) {
  const { resolution, notes } = payload || {};
  const normalized = String(resolution || '').toUpperCase();
  if (!DISCREPANCY_RESOLUTIONS.includes(normalized)) {
    throw AppError.badRequest(`"resolution" precisa ser um de: ${DISCREPANCY_RESOLUTIONS.join(', ')}.`, 'RECEIPT_DISCREPANCY_VALIDATION');
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 41, 2026-10-05): faltava lock
  // pessimista aqui — inconsistente com o resto do arquivo (decidePurchaseRequest,
  // awardSupplierOffer, confirmGoodsReceipt já usam lock: transaction.LOCK.UPDATE). Duas
  // decisões concorrentes (ex.: ACCEPTED e REJECTED quase simultâneas) podiam ambas ler
  // status OPEN antes de qualquer commit e gravar decisões conflitantes (lost update), sem
  // nenhuma delas ser bloqueada com RECEIPT_DISCREPANCY_INVALID_STATUS como deveria.
  const discrepancy = await ReceiptDiscrepancy.findByPk(discrepancyId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!discrepancy) throw AppError.notFound('Divergência não encontrada.', 'RECEIPT_DISCREPANCY_NOT_FOUND');
  if (discrepancy.status !== 'OPEN') {
    throw AppError.conflict(`Divergência com status "${discrepancy.status}" já foi resolvida.`, 'RECEIPT_DISCREPANCY_INVALID_STATUS');
  }

  const beforeJson = discrepancy.toJSON();
  discrepancy.status = normalized;
  discrepancy.resolutionNotes = notes || null;
  discrepancy.resolvedByUserId = actor.userId || null;
  discrepancy.resolvedAt = new Date();
  await discrepancy.save({ transaction });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 26, 2026-10-05): rejeitar uma
  // divergência de PREÇO (PRICE_MISMATCH, R25) só mudava o status da divergência — o payable
  // criado em confirmGoodsReceipt continuava com o valor contestado da nota fiscal. Rejeitar a
  // divergência precisa corrigir o contas a pagar pro valor esperado (PO x quantidade), nunca
  // deixar a empresa pagando o valor que o próprio sistema já identificou como errado.
  // `amount` nunca é editável num FinancialEntry existente (FIN-010, "nunca edita o valor") —
  // por isso estorna o payable antigo e cria um novo, correto, no lugar.
  if (discrepancy.discrepancyType === 'PRICE_MISMATCH' && normalized === 'REJECTED') {
    const grItem = await GoodsReceiptItem.findByPk(discrepancy.goodsReceiptItemId, { transaction });
    const goodsReceipt = grItem ? await GoodsReceipt.findByPk(grItem.goodsReceiptId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (goodsReceipt && goodsReceipt.financialEntryId) {
      const { reverseFinancialEntry } = require('../finance/financialEntries.service');
      await reverseFinancialEntry(
        goodsReceipt.financialEntryId,
        `Divergência de preço rejeitada — valor da NF (${discrepancy.receivedValue}) não confere com o esperado (${discrepancy.expectedValue}).`,
        actor.userId,
        transaction
      );
      const correctedPayable = await createFinancialEntry(
        {
          groupId: goodsReceipt.groupId,
          companyId: goodsReceipt.companyId,
          entryType: 'DEBIT',
          nature: 'PAYABLE',
          amount: Number(discrepancy.expectedValue),
          description: `Recebimento de materiais (corrigido após rejeição de divergência de preço) — recebimento ${goodsReceipt.id}.`,
          idempotencyKey: `goods-receipt:${goodsReceipt.id}:price-corrected:${discrepancy.id}`,
        },
        actor.userId,
        transaction
      );
      goodsReceipt.financialEntryId = correctedPayable.id;
      goodsReceipt.updatedBy = actor.userId || null;
      await goodsReceipt.save({ transaction });
    }
  }

  await registrarAuditoria(
    {
      groupId: discrepancy.groupId, companyId: discrepancy.companyId, actorUserId: actor.userId,
      action: 'procurement.receipt_discrepancy.resolve',
      entityType: 'ReceiptDiscrepancy', entityId: discrepancy.id,
      beforeJson, afterJson: discrepancy.toJSON(),
      reason: `Divergência de recebimento resolvida como ${normalized}.`,
    },
    transaction
  );

  return discrepancy;
}

// --- Avaliação de fornecedor ---
async function evaluateSupplier(payload, actorUserId, transaction) {
  const { groupId, companyId, supplierPersonId, purchaseOrderId, score, notes } = payload;
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): guard sem
  // Number.isFinite — score:"NaN" não é null e Number(NaN)<1/Number(NaN)>5 são ambos false,
  // passando a validação e corrompendo getAverageScore (NaN se propaga pra toda média futura).
  if (!groupId || !companyId || !supplierPersonId || score == null || !Number.isFinite(Number(score)) || Number(score) < 1 || Number(score) > 5) {
    throw AppError.badRequest('"groupId", "companyId", "supplierPersonId" e "score" (1 a 5) são obrigatórios.', 'SUPPLIER_EVALUATION_VALIDATION');
  }
  return SupplierEvaluation.create(
    { groupId, companyId, supplierPersonId, purchaseOrderId: purchaseOrderId || null, score, notes: notes || null, createdBy: actorUserId || null },
    { transaction }
  );
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 17, 2026-10-05): evaluateSupplier só
// gravava — não existia nenhuma leitura (endpoint, service, uso interno) da avaliação, apesar
// do contrato listar `supplier_evaluations` como parte do fluxo de Procurement. Mesma família
// de bug "dado gravado e nunca lido" das rodadas 7/8/9/10. `averageScore` é a agregação mais
// útil pra decidir um próximo AWARD — nota histórica do fornecedor, não só a lista crua.
async function listSupplierEvaluations(transaction, { supplierPersonId } = {}) {
  const where = {};
  if (supplierPersonId) where.supplierPersonId = supplierPersonId;
  const evaluations = await SupplierEvaluation.findAll({ where, order: [['created_at', 'DESC']], transaction });
  const averageScore = evaluations.length > 0
    ? Math.round((evaluations.reduce((acc, e) => acc + Number(e.score), 0) / evaluations.length) * 100) / 100
    : null;
  return { evaluations, averageScore, count: evaluations.length };
}

// BUG REAL CORRIGIDO (auditoria contratual, 2026-10-07): contrato exige "Cancel/return =
// compensação" — não existia nenhum endpoint pra cancelar uma PO. Cancelar uma PO com itens
// ainda não totalmente recebidos precisa deixar rastro formal da parte que não vai mais chegar
// (UNDER_RECEIPT), em vez de simplesmente sumir com o saldo pendente do PO sem explicação —
// mesmo espírito fail-closed/auditável de OVER_RECEIPT e PRICE_MISMATCH já existentes. O que já
// foi fisicamente recebido/pago não é revertido aqui (reversão de estoque/financeiro já
// recebido é uma devolução de verdade, fora do mínimo contratual de "cancel/return = registrar
// a compensação", que é o que este fluxo cobre).
const CANCELABLE_STATUSES = ['OPEN', 'RECEIVED'];

async function cancelPurchaseOrder(id, payload, actor, transaction) {
  const order = await PurchaseOrder.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  if (!CANCELABLE_STATUSES.includes(order.status)) {
    throw AppError.conflict(`Pedido de compra com status "${order.status}" não pode ser cancelado.`, 'PURCHASE_ORDER_INVALID_TRANSITION');
  }

  const items = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });
  const underReceivedItems = items.filter((i) => Number(i.receivedQuantity) < Number(i.quantity));

  const discrepancies = [];
  for (const item of underReceivedItems) {
    const remaining = Number(item.quantity) - Number(item.receivedQuantity);
    const lastGrItem = await GoodsReceiptItem.findOne({
      where: { purchaseOrderItemId: item.id }, order: [['created_at', 'DESC']], transaction,
    });
    // UNDER_RECEIPT só tem onde pendurar (goodsReceiptItemId é obrigatório no schema) quando já
    // houve pelo menos um recebimento parcial do item; cancelamento sem nenhum recebimento ainda
    // não é discrepância de recebimento — é simplesmente um pedido que nunca chegou a ser
    // entregue, registrado só pelo status CANCELED + a auditoria abaixo.
    if (lastGrItem) {
      discrepancies.push(
        await ReceiptDiscrepancy.create(
          {
            groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: lastGrItem.id,
            discrepancyType: 'UNDER_RECEIPT', expectedValue: Number(item.quantity), receivedValue: Number(item.receivedQuantity),
            status: 'OPEN',
          },
          { transaction }
        )
      );
    }
  }

  order.status = 'CANCELED';
  order.updatedBy = actor.userId || null;
  await order.save({ transaction });

  await registrarAuditoria(
    {
      groupId: order.groupId, companyId: order.companyId, actorUserId: actor.userId,
      action: 'PURCHASE_ORDER_CANCELED', entityType: 'PurchaseOrder', entityId: order.id,
      reason: payload?.reason || `PO cancelada — ${underReceivedItems.length} item(ns) com saldo não recebido (compensação registrada).`,
    },
    transaction
  );

  return { order, discrepancies };
}

// --- Due diligence / qualificação de fornecedor ---
// Contrato (Anexo I): "Fornecedores: documentos/vigência; due diligence para alto risco".
const DUE_DILIGENCE_STATUSES = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'];

async function upsertSupplierQualification(payload, actorUserId, transaction) {
  const { groupId, companyId, supplierPersonId, documentFileIds, validUntil, highRisk } = payload || {};
  if (!groupId || !companyId || !supplierPersonId) {
    throw AppError.badRequest('"groupId", "companyId" e "supplierPersonId" são obrigatórios.', 'SUPPLIER_QUALIFICATION_VALIDATION');
  }

  let qualification = await SupplierQualification.findOne({ where: { companyId, supplierPersonId }, transaction, lock: transaction.LOCK.UPDATE });
  const isHighRisk = Boolean(highRisk);
  const fields = {
    documentFileIds: Array.isArray(documentFileIds) ? documentFileIds : (qualification?.documentFileIds || []),
    validUntil: validUntil || qualification?.validUntil || null,
    highRisk: isHighRisk,
    updatedBy: actorUserId || null,
  };

  if (!qualification) {
    qualification = await SupplierQualification.create(
      { groupId, companyId, supplierPersonId, ...fields, dueDiligenceStatus: isHighRisk ? 'PENDING' : 'NOT_REQUIRED', createdBy: actorUserId || null },
      { transaction }
    );
  } else {
    // Virar alto risco reabre a due diligence (nunca mantém um APPROVED antigo válido pra um
    // risco que acabou de ser identificado); deixar de ser alto risco zera a exigência.
    if (isHighRisk && qualification.dueDiligenceStatus !== 'APPROVED') fields.dueDiligenceStatus = 'PENDING';
    if (isHighRisk && !qualification.highRisk) fields.dueDiligenceStatus = 'PENDING';
    if (!isHighRisk) fields.dueDiligenceStatus = 'NOT_REQUIRED';
    Object.assign(qualification, fields);
    await qualification.save({ transaction });
  }

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'SUPPLIER_QUALIFICATION_UPDATED', entityType: 'SupplierQualification', entityId: qualification.id, reason: `Documentos/vigência/risco atualizados (highRisk=${isHighRisk}).` },
    transaction
  );

  return qualification;
}

async function decideSupplierDueDiligence(id, payload, actor, transaction) {
  const { decision, notes } = payload || {};
  const normalized = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalized)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'SUPPLIER_QUALIFICATION_VALIDATION');
  }

  const qualification = await SupplierQualification.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!qualification) throw AppError.notFound('Qualificação de fornecedor não encontrada.', 'SUPPLIER_QUALIFICATION_NOT_FOUND');
  if (!qualification.highRisk) {
    throw AppError.badRequest('Fornecedor não está marcado como alto risco — não exige due diligence.', 'SUPPLIER_QUALIFICATION_NOT_HIGH_RISK');
  }

  qualification.dueDiligenceStatus = normalized;
  qualification.dueDiligenceNotes = notes || null;
  qualification.approvedByUserId = actor.userId || null;
  qualification.approvedAt = new Date();
  qualification.updatedBy = actor.userId || null;
  await qualification.save({ transaction });

  await registrarAuditoria(
    { groupId: qualification.groupId, companyId: qualification.companyId, actorUserId: actor.userId, action: 'SUPPLIER_DUE_DILIGENCE_DECIDED', entityType: 'SupplierQualification', entityId: qualification.id, reason: `Due diligence ${normalized.toLowerCase()}.` },
    transaction
  );

  return qualification;
}

async function listSupplierQualifications(transaction, { supplierPersonId } = {}) {
  const where = {};
  if (supplierPersonId) where.supplierPersonId = supplierPersonId;
  return SupplierQualification.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

module.exports = {
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  decidePurchaseRequest,
  createQuotation,
  submitSupplierOffer,
  compareOffers,
  awardSupplierOffer,
  getPurchaseOrder,
  listPurchaseOrders,
  confirmGoodsReceipt,
  listGoodsReceipts,
  listDiscrepancies,
  resolveDiscrepancy,
  evaluateSupplier,
  listSupplierEvaluations,
  cancelPurchaseOrder,
  upsertSupplierQualification,
  decideSupplierDueDiligence,
  listSupplierQualifications,
};
