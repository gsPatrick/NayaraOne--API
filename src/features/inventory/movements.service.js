'use strict';

const { InventoryMovement, InventoryItem, InventoryLocation, InventoryStockBalance } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMovementRecorded, publishStockLow } = require('./inventoryEvents.service');

// EST-00x (Caderno Marco 7): 7 tipos de movimento. ADJUSTMENT/LOSS/DISPOSAL exigem
// inventory:approve (mesmo padrão de alçada já usado em construction:approve/finance:approve)
// porque alteram saldo sem uma origem física rastreável (recebimento/requisição/devolução).
const MOVEMENT_TYPES = ['IN', 'OUT', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'LOSS', 'DISPOSAL'];
const APPROVAL_REQUIRED_TYPES = ['ADJUSTMENT', 'LOSS', 'DISPOSAL'];

// EST-002: saldo é sempre derivado de movimentos, nunca digitável diretamente — esta é a
// ÚNICA função do sistema que deve escrever em inventory.stock_balances.
async function applyBalanceDelta(inventoryItemId, locationId, delta, companyId, groupId, allowNegativeStock, transaction) {
  let balance = await InventoryStockBalance.findOne({
    where: { inventoryItemId, locationId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  if (!balance) {
    balance = await InventoryStockBalance.create(
      { groupId, companyId, inventoryItemId, locationId, quantityOnHand: 0 },
      { transaction }
    );
  }

  const nextQuantity = Number(balance.quantityOnHand) + Number(delta);
  // Documento "Banco de Dados Físico BLINDADO": "OUT não pode gerar saldo negativo QUANDO item
  // não permitir estoque negativo" — regra condicional, não incondicional (allowNegativeStock).
  if (nextQuantity < 0 && !allowNegativeStock) {
    throw AppError.badRequest(
      `Saldo insuficiente no local informado (disponível: ${balance.quantityOnHand}, solicitado: ${Math.abs(delta)}).`,
      'INVENTORY_INSUFFICIENT_BALANCE'
    );
  }

  balance.quantityOnHand = nextQuantity;
  await balance.save({ transaction });
  return balance;
}

async function recordMovement(payload, actor, transaction) {
  const {
    groupId,
    companyId,
    inventoryItemId,
    projectId,
    movementType,
    quantity,
    sourceLocationId,
    destinationLocationId,
    sourceType,
    sourceId,
    idempotencyKey,
    movedAt,
    responsiblePersonId,
    evidenceFileId,
    reason,
  } = payload;

  if (!groupId || !companyId || !inventoryItemId || !movementType || quantity == null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "inventoryItemId", "movementType" e "quantity" são obrigatórios.',
      'INVENTORY_MOVEMENT_VALIDATION'
    );
  }
  if (!MOVEMENT_TYPES.includes(movementType)) {
    throw AppError.badRequest(`"movementType" precisa ser um de: ${MOVEMENT_TYPES.join(', ')}.`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw AppError.badRequest('"quantity" precisa ser um número maior que zero.', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && !actor.canApprove) {
    throw AppError.forbidden(
      `Movimento do tipo "${movementType}" exige a permissão inventory:approve.`,
      'INVENTORY_MOVEMENT_APPROVAL_REQUIRED'
    );
  }

  const item = await InventoryItem.findByPk(inventoryItemId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');

  if ((movementType === 'OUT' || movementType === 'LOSS' || movementType === 'DISPOSAL') && !sourceLocationId) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "sourceLocationId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if ((movementType === 'IN' || movementType === 'RETURN') && !destinationLocationId) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "destinationLocationId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'TRANSFER' && (!sourceLocationId || !destinationLocationId)) {
    throw AppError.badRequest('Movimento "TRANSFER" exige "sourceLocationId" e "destinationLocationId".', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'ADJUSTMENT' && !sourceLocationId && !destinationLocationId) {
    throw AppError.badRequest('Movimento "ADJUSTMENT" exige "sourceLocationId" ou "destinationLocationId".', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // EST-008: ajuste/perda/descarte exigem motivo (evidência é recomendada, mas só obrigatória
  // quando a política da empresa exigir — isso é regra de negócio do Motor de Regras, fora de
  // código fixo; aqui garantimos o mínimo "sempre obrigatório" do Caderno, que é o motivo).
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && !reason) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "reason" (motivo).`, 'INVENTORY_MOVEMENT_REASON_REQUIRED');
  }
  // EST-006: saída de ferramenta/ativo (item_type TOOL/ASSET) exige responsável.
  if ((movementType === 'OUT' || movementType === 'TRANSFER') && ['TOOL', 'ASSET'].includes(item.itemType) && !responsiblePersonId) {
    throw AppError.badRequest(`Movimento "${movementType}" de ferramenta/ativo exige "responsiblePersonId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // EST-004: material atribuído à obra (entra/sai de um local PROJECT_SITE) precisa de projectId.
  const touchedLocationIds = [sourceLocationId, destinationLocationId].filter(Boolean);
  if (touchedLocationIds.length > 0 && !projectId) {
    const siteLocations = await InventoryLocation.findAll({
      where: { id: touchedLocationIds, locationType: 'PROJECT_SITE' },
      transaction,
    });
    if (siteLocations.length > 0) {
      throw AppError.badRequest('Movimento envolvendo local de obra (PROJECT_SITE) exige "projectId" (EST-004).', 'INVENTORY_MOVEMENT_PROJECT_REQUIRED');
    }
  }

  // EST-00x: idempotência — reenvio do mesmo payload (ex.: retry de rede) não duplica o movimento.
  if (idempotencyKey) {
    const existing = await InventoryMovement.findOne({ where: { companyId, idempotencyKey }, transaction });
    if (existing) return existing;
  }

  const movement = await InventoryMovement.create(
    {
      groupId,
      companyId,
      inventoryItemId,
      projectId: projectId || null,
      movementType,
      quantity: qty,
      sourceLocationId: sourceLocationId || null,
      destinationLocationId: destinationLocationId || null,
      sourceType: sourceType || 'MANUAL',
      sourceId: sourceId || null,
      idempotencyKey: idempotencyKey || null,
      movedAt: movedAt || new Date(),
      movedByUserId: actor.userId || null,
      responsiblePersonId: responsiblePersonId || null,
      evidenceFileId: evidenceFileId || null,
      reason: reason || null,
      createdBy: actor.userId || null,
      updatedBy: actor.userId || null,
    },
    { transaction }
  );

  const allowNegative = item.allowNegativeStock;
  const touchedBalances = [];

  // Aplica o delta de saldo por local — TRANSFER move entre dois locais na mesma transação,
  // o que garante atomicidade (EST-003): nunca existe estado intermediário com saldo "perdido".
  if (movementType === 'OUT' || movementType === 'LOSS' || movementType === 'DISPOSAL') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'IN' || movementType === 'RETURN') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'TRANSFER') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'ADJUSTMENT') {
    // Ajuste positivo soma no destino; ajuste negativo subtrai da origem — sinal definido por
    // qual dos dois campos veio preenchido no payload.
    if (destinationLocationId) {
      touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
    } else {
      touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
    }
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId: actor.userId || null,
      action: 'INVENTORY_MOVEMENT_RECORDED',
      entityType: 'InventoryMovement',
      entityId: movement.id,
      afterJson: { movementType, quantity: qty, inventoryItemId, sourceLocationId, destinationLocationId },
      reason: `Movimento de estoque "${movementType}" de ${qty} unidade(s) registrado.`,
    },
    transaction
  );

  await publishMovementRecorded(movement, transaction);

  // EST-012: estoque mínimo — avisa (NAY sugere, nunca efetiva) quando o saldo resultante de
  // um local tocado por este movimento cruza para abaixo do minimumQuantity do item.
  if (item.minimumQuantity != null) {
    for (const balance of touchedBalances) {
      if (Number(balance.quantityOnHand) < Number(item.minimumQuantity)) {
        await publishStockLow(item, balance.locationId, balance.quantityOnHand, transaction);
      }
    }
  }

  return movement;
}

async function getBalance(inventoryItemId, locationId, transaction) {
  const balance = await InventoryStockBalance.findOne({ where: { inventoryItemId, locationId }, transaction });
  return balance ? Number(balance.quantityOnHand) : 0;
}

async function listBalancesByItem(inventoryItemId, transaction) {
  return InventoryStockBalance.findAll({
    where: { inventoryItemId },
    include: [{ model: InventoryLocation, as: 'location' }],
    transaction,
  });
}

module.exports = { MOVEMENT_TYPES, APPROVAL_REQUIRED_TYPES, recordMovement, getBalance, listBalancesByItem };
