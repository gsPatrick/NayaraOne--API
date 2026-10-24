'use strict';

const { Op } = require('sequelize');
const { InventoryReceipt, InventoryReceiptItem, InventoryLocation, InventoryItem, InventoryStockBalance, Person } = require('../../models');
const AppError = require('../../utils/AppError');

// BUG GRAVE REAL CORRIGIDO (auditoria Marco 7 "reval", 2026-10-16): a checagem de NF duplicada
// comparava invoiceNumber por igualdade exata (case/espaço sensível) — "AUDIT-NF-0001" e
// "audit-nf-0001" (ou com espaço extra) eram tratados como notas DIFERENTES, permitindo dupla
// entrada de estoque pela mesma nota fiscal digitada de forma diferente. Número de NF é a chave
// de negócio real; precisa normalizar (trim + colapsar espaços internos) e comparar
// case-insensitive (ILIKE) antes de checar duplicidade.
function normalizeInvoiceNumber(invoiceNumber) {
  return invoiceNumber.trim().replace(/\s+/g, ' ');
}
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishReceiptCompleted } = require('./inventoryEvents.service');

// Guia do Marcelo §4: Entrada por NF — DRAFT (cadastro) -> REVIEWED (conferido) ->
// COMPLETED (confirmado, gera IN e atualiza saldo+custo). EST-TS-01/EST-TS-08: recebimento
// duplicado (mesmo invoiceFingerprint) não gera entrada duplicada.
const STATUSES = ['DRAFT', 'REVIEWED', 'COMPLETED'];

async function createReceipt(payload, actorUserId, transaction) {
  const { groupId, companyId, destinationLocationId, supplierPersonId, invoiceNumber, invoiceFingerprint, invoiceFileId, notes, items } = payload;

  if (!groupId || !companyId || !destinationLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "destinationLocationId" e "items" (não vazio) são obrigatórios.',
      'INVENTORY_RECEIPT_VALIDATION'
    );
  }
  for (const line of items) {
    if (!line.inventoryItemId || line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "inventoryItemId" e "quantity" > 0.', 'INVENTORY_RECEIPT_VALIDATION');
    }
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 57, 2026-10-06): unitCost não era
    // validado — um valor negativo corrompe o cálculo de averageCost ponderado abaixo, afetando
    // toda valoração futura do item (diferente do fluxo PO-driven, que já valida unitPrice>=0 na
    // origem — este endpoint de recebimento direto de inventário não passa por lá).
    if (line.unitCost != null && (!Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0)) {
      throw AppError.badRequest('"unitCost" do item deve ser um número maior ou igual a zero.', 'INVENTORY_RECEIPT_VALIDATION');
    }
  }

  const location = await InventoryLocation.findByPk(destinationLocationId, { transaction });
  if (!location) throw AppError.notFound('Local de destino não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');

  // BUG REAL CORRIGIDO (auditoria Marco 7, rodada "check", 2026-10-15): esta checagem só olhava
  // "invoiceFingerprint" (campo de texto livre opcional, "Identificador único"), mas o front manda
  // o arquivo anexado em "invoiceFileId" — um usuário que anexa a NF de verdade mas não preenche o
  // texto opcional era recusado com "é preciso anexar o arquivo", mesmo com o arquivo já anexado.
  // Além disso, desde a correção anterior (EST-TS-08), a checagem por "invoiceNumber" abaixo já
  // detecta duplicidade de verdade sozinha quando o número da nota é informado — então só falta
  // uma evidência (arquivo OU fingerprint) quando NÃO há número de nota pra se apoiar.
  if ((invoiceNumber || supplierPersonId) && !invoiceNumber && !invoiceFingerprint && !invoiceFileId) {
    throw AppError.badRequest(
      'Quando o recebimento tem fornecedor mas não tem número de nota fiscal, é preciso anexar o arquivo da nota para detectar duplicidade.',
      'INVENTORY_RECEIPT_FINGERPRINT_REQUIRED'
    );
  }

  // EST-TS-08: NF duplicada por fingerprint é detectada já na criação, não só na confirmação.
  if (invoiceFingerprint) {
    const existing = await InventoryReceipt.findOne({ where: { companyId, invoiceFingerprint }, transaction });
    if (existing) {
      const label = existing.invoiceNumber ? `nota fiscal nº ${existing.invoiceNumber}` : 'esta mesma nota fiscal';
      throw AppError.badRequest(
        `Já existe um recebimento registrado para ${label}.`,
        'INVENTORY_RECEIPT_DUPLICATE_INVOICE'
      );
    }
  }

  // BUG GRAVE REAL CORRIGIDO (auditoria Marco 7, rodada "check"): o "identificador único" acima
  // é texto LIVRE digitado pelo usuário, não um hash real do arquivo — então a mesma nota fiscal
  // confirmada duas vezes com um valor de identificador diferente (ou com erro de digitação)
  // passava direto pela checagem de fingerprint. O número da nota fiscal é a chave de negócio real
  // e nunca deveria aceitar duplicata nesta empresa, independente do que foi digitado no campo de
  // identificador.
  if (invoiceNumber) {
    const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber);
    const existingByNumber = await InventoryReceipt.findOne({
      // Revisão Marco 7 (19/10/2026, B11): numeração de NF é por emitente — a duplicidade é por
      // (empresa, fornecedor, número). Sem fornecedor informado, compara com os recebimentos também
      // sem fornecedor (nunca libera por omissão).
      where: { companyId, supplierPersonId: supplierPersonId || null, invoiceNumber: { [Op.iLike]: normalizedInvoiceNumber } },
      transaction,
    });
    if (existingByNumber) {
      throw AppError.badRequest(
        `Já existe um recebimento registrado para a nota fiscal nº ${existingByNumber.invoiceNumber}.`,
        'INVENTORY_RECEIPT_DUPLICATE_INVOICE'
      );
    }
  }

  const receipt = await InventoryReceipt.create(
    {
      groupId,
      companyId,
      destinationLocationId,
      supplierPersonId: supplierPersonId || null,
      invoiceNumber: invoiceNumber ? normalizeInvoiceNumber(invoiceNumber) : null,
      invoiceFingerprint: invoiceFingerprint || null,
      invoiceFileId: invoiceFileId || null,
      notes: notes || null,
      status: 'DRAFT',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  for (const line of items) {
    const item = await InventoryItem.findOne({ where: { id: line.inventoryItemId, groupId, companyId }, transaction });
    if (!item) throw AppError.notFound(`Item de estoque "${line.inventoryItemId}" não encontrado.`, 'INVENTORY_ITEM_NOT_FOUND');
    await InventoryReceiptItem.create(
      {
        groupId,
        companyId,
        receiptId: receipt.id,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: line.unitCost != null ? line.unitCost : null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_RECEIPT_CREATED', entityType: 'InventoryReceipt', entityId: receipt.id,
      afterJson: {
        ...receipt.toJSON(),
        items: items.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity, unitCost: l.unitCost != null ? l.unitCost : null })),
      },
      reason: 'Recebimento criado (DRAFT).' },
    transaction
  );

  return getReceipt(receipt.id, groupId, companyId, transaction);
}

async function getReceipt(receiptId, groupId, companyId, transaction) {
  const receipt = await InventoryReceipt.findOne({
    where: { id: receiptId, groupId, companyId },
    include: [
      { model: InventoryReceiptItem, as: 'items' },
      { model: Person, as: 'supplier', attributes: ['id', 'legalName'], required: false },
    ],
    transaction,
  });
  if (!receipt) throw AppError.notFound('Recebimento não encontrado.', 'INVENTORY_RECEIPT_NOT_FOUND');
  return receipt;
}

async function listReceipts(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return InventoryReceipt.findAll({
    where,
    include: [{ model: Person, as: 'supplier', attributes: ['id', 'legalName'], required: false }],
    order: [['created_at', 'DESC']],
    limit: 1500,
    transaction,
  });
}

async function reviewReceipt(receiptId, actorUserId, groupId, companyId, transaction) {
  const receipt = await InventoryReceipt.findOne({ where: { id: receiptId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!receipt) throw AppError.notFound('Recebimento não encontrado.', 'INVENTORY_RECEIPT_NOT_FOUND');
  if (receipt.status !== 'DRAFT') {
    throw AppError.badRequest(`Só é possível revisar um recebimento em DRAFT (atual: ${receipt.status}).`, 'INVENTORY_RECEIPT_INVALID_TRANSITION');
  }
  receipt.status = 'REVIEWED';
  receipt.updatedBy = actorUserId || null;
  await receipt.save({ transaction });
  return receipt;
}

// `options.movementReason` (opcional): motivo explícito pros movimentos IN deste recebimento.
// Usado pelo excedente aceito de Compras (procurement.resolveDiscrepancy), que é um recibo
// COMPLEMENTAR da mesma NF já registrada — ele não pode reivindicar o `invoiceNumber` de novo
// (a trava de NF duplicada, correta, recusaria), mas o movimento precisa citar a NF de origem.
async function confirmReceipt(receiptId, actor, groupId, companyId, transaction, options = {}) {
  // Postgres rejeita FOR UPDATE combinado com include de hasMany (outer join nullable) — o lock
  // é feito só na linha do receipt; os itens (já imutáveis depois de criados) são lidos depois.
  const receipt = await InventoryReceipt.findOne({ where: { id: receiptId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!receipt) throw AppError.notFound('Recebimento não encontrado.', 'INVENTORY_RECEIPT_NOT_FOUND');
  if (receipt.status !== 'REVIEWED') {
    throw AppError.badRequest(`Só é possível confirmar um recebimento em REVIEWED (atual: ${receipt.status}).`, 'INVENTORY_RECEIPT_INVALID_TRANSITION');
  }
  const items = await InventoryReceiptItem.findAll({ where: { receiptId: receipt.id, groupId, companyId }, transaction });

  // EST-TS-08 (segunda barreira): mesmo se dois agentes tentarem confirmar o mesmo invoiceFingerprint
  // concorrentemente, o lock de linha acima + o status check (REVIEWED->COMPLETED, não reentrante)
  // garante que só a primeira confirmação produz movimento — EST-TS-01 (mesmo recebimento 2x = uma entrada).
  for (const line of items) {
    // EST-011: custo médio ponderado, única política de custo do módulo — nenhum outro ponto
    // do código escreve em InventoryItem.averageCost. Soma ANTES de aplicar o IN desta linha,
    // senão o próprio recebimento já contaminaria o denominador da média.
    if (line.unitCost != null) {
      const item = await InventoryItem.findOne({ where: { id: line.inventoryItemId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
      const balancesBefore = await InventoryStockBalance.findAll({ where: { inventoryItemId: line.inventoryItemId, groupId, companyId }, transaction });
      const totalQtyBefore = balancesBefore.reduce((sum, b) => sum + Number(b.quantityOnHand), 0);
      const oldAverage = item.averageCost != null ? Number(item.averageCost) : Number(line.unitCost);
      const receivedQty = Number(line.quantity);
      // Revisão Marco 7 (19/10/2026), A10: com saldo negativo (item que permite estoque
      // negativo) o denominador ficava 0 (divisão por zero → erro no banco) ou a média saía
      // distorcida (ex.: saldo −3 a 20 + 6 a 40 = 60, acima de qualquer custo real). Saldo ≤ 0
      // não tem valor a ponderar: a quantidade anterior entra como 0 e o custo médio passa a ser
      // o custo desta entrada — nunca uma média com denominador ≤ 0.
      const weightedQtyBefore = Math.max(0, totalQtyBefore);
      item.averageCost = (weightedQtyBefore * oldAverage + receivedQty * Number(line.unitCost)) / (weightedQtyBefore + receivedQty);
      item.updatedBy = actor.userId || null;
      await item.save({ transaction });
    }

    await recordMovement(
      {
        groupId: receipt.groupId,
        companyId: receipt.companyId,
        inventoryItemId: line.inventoryItemId,
        movementType: 'IN',
        quantity: line.quantity,
        destinationLocationId: receipt.destinationLocationId,
        sourceType: 'RECEIPT',
        sourceId: receipt.id,
        idempotencyKey: `receipt:${receipt.id}:item:${line.id}`,
        // A1/EST-011: entrada guarda o custo da nota (custo histórico do movimento).
        unitCost: line.unitCost != null ? line.unitCost : undefined,
        reason: options.movementReason
          || (receipt.invoiceNumber
            ? `Recebimento da nota fiscal nº ${receipt.invoiceNumber}.`
            : 'Recebimento de mercadoria.'),
      },
      actor,
      transaction
    );
  }

  const auditBefore = { status: receipt.status, destinationLocationId: receipt.destinationLocationId, invoiceNumber: receipt.invoiceNumber, itemCount: items.length };
  receipt.status = 'COMPLETED';
  receipt.updatedBy = actor.userId || null;
  await receipt.save({ transaction });

  await publishReceiptCompleted(receipt, transaction);

  await registrarAuditoria(
    { groupId: receipt.groupId, companyId: receipt.companyId, actorUserId: actor.userId, action: 'INVENTORY_RECEIPT_COMPLETED', entityType: 'InventoryReceipt', entityId: receipt.id,
      beforeJson: auditBefore,
      afterJson: {
        status: receipt.status,
        destinationLocationId: receipt.destinationLocationId,
        invoiceNumber: receipt.invoiceNumber,
        itemCount: items.length,
        stockIn: items.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity, unitCost: l.unitCost })),
      },
      reason: 'Recebimento confirmado — entrada de estoque gerada.' },
    transaction
  );

  return receipt;
}

module.exports = { STATUSES, createReceipt, getReceipt, listReceipts, reviewReceipt, confirmReceipt };
