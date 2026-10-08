'use strict';

const { InventoryItem, InventoryLocation } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishItemCreated } = require('./inventoryEvents.service');
const { createMinStockRule } = require('./minStockRules.service');

const ITEM_TYPES = ['CONSUMABLE', 'TOOL', 'ASSET', 'SERVICE_ITEM'];
const LOCATION_TYPES = ['WAREHOUSE', 'PROJECT_SITE'];

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 47, 2026-10-05): o contrato (TAB-0750)
// trata "sku" e "unit_code" (unit_of_measure) como NOT NULL, com UNIQUE(company_id, sku) — mas
// nada no sistema exigia esses campos, permitindo catálogo sem SKU e sem unidade de medida
// (quebra qualquer cálculo/relatório que dependa deles).
async function createItem(payload, actorUserId, transaction) {
  const { groupId, companyId, name, unitOfMeasure, itemType, sku, minimumQuantity } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'INVENTORY_ITEM_VALIDATION');
  }
  if (!sku) {
    throw AppError.badRequest('O campo "sku" é obrigatório (TAB-0750).', 'INVENTORY_ITEM_VALIDATION');
  }
  if (!unitOfMeasure) {
    throw AppError.badRequest('O campo "unitOfMeasure" é obrigatório (TAB-0750).', 'INVENTORY_ITEM_VALIDATION');
  }
  const existing = await InventoryItem.findOne({ where: { companyId, sku }, transaction });
  if (existing) {
    throw AppError.badRequest(`Já existe um item com o SKU "${sku}" nesta empresa.`, 'INVENTORY_ITEM_DUPLICATE_SKU');
  }
  if (itemType && !ITEM_TYPES.includes(itemType)) {
    throw AppError.badRequest(`"itemType" precisa ser um de: ${ITEM_TYPES.join(', ')}.`, 'INVENTORY_ITEM_VALIDATION');
  }
  if (minimumQuantity != null && (!Number.isFinite(Number(minimumQuantity)) || Number(minimumQuantity) < 0)) {
    throw AppError.badRequest('"minimumQuantity" precisa ser um número >= 0.', 'INVENTORY_ITEM_VALIDATION');
  }
  if (minimumQuantity != null && itemType === 'SERVICE_ITEM') {
    throw AppError.badRequest('Item do tipo "SERVICE_ITEM" não tem saldo físico — não admite estoque mínimo.', 'INVENTORY_ITEM_VALIDATION');
  }

  const item = await InventoryItem.create(
    {
      groupId,
      companyId,
      sku,
      name,
      unitOfMeasure,
      itemType: itemType || 'CONSUMABLE',
      minimumQuantity: minimumQuantity != null ? minimumQuantity : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await publishItemCreated(item, transaction);
  // EST-012: o estoque mínimo informado no cadastro não é mais "a regra" — vira a versão 1 da
  // política REG-EST-001 do item no Motor de Regras (minStockRules.service.js); a coluna
  // minimum_quantity gravada acima é só o espelho de compatibilidade.
  if (minimumQuantity != null) {
    await createMinStockRule(
      { groupId, companyId, inventoryItemId: item.id, minimumQuantity, description: 'Definido no cadastro do item.' },
      actorUserId,
      transaction
    );
  }
  return item;
}

async function listItems(transaction, { itemType, status } = {}) {
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  else if (!status) where.status = 'ACTIVE';
  if (itemType) where.itemType = itemType;
  return InventoryItem.findAll({ where, order: [['name', 'ASC']], transaction });
}

async function getItem(itemId, transaction) {
  const item = await InventoryItem.findByPk(itemId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  return item;
}

async function setItemStatus(itemId, status, actorUserId, transaction) {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw AppError.badRequest('"status" precisa ser "ACTIVE" ou "INACTIVE".', 'INVENTORY_ITEM_VALIDATION');
  }
  const item = await getItem(itemId, transaction);
  item.status = status;
  item.updatedBy = actorUserId || null;
  await item.save({ transaction });
  return item;
}

async function createLocation(payload, actorUserId, transaction) {
  const { groupId, companyId, name, locationType, projectId } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'INVENTORY_LOCATION_VALIDATION');
  }
  if (locationType && !LOCATION_TYPES.includes(locationType)) {
    throw AppError.badRequest(`"locationType" precisa ser um de: ${LOCATION_TYPES.join(', ')}.`, 'INVENTORY_LOCATION_VALIDATION');
  }
  return InventoryLocation.create(
    {
      groupId,
      companyId,
      name,
      locationType: locationType || 'WAREHOUSE',
      projectId: projectId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listLocations(transaction) {
  return InventoryLocation.findAll({ where: { isActive: true }, order: [['name', 'ASC']], transaction });
}

module.exports = { ITEM_TYPES, LOCATION_TYPES, createItem, listItems, getItem, setItemStatus, createLocation, listLocations };
