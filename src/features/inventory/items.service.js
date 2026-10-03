'use strict';

const { InventoryItem, InventoryLocation } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishItemCreated } = require('./inventoryEvents.service');

const ITEM_TYPES = ['CONSUMABLE', 'TOOL', 'ASSET', 'SERVICE_ITEM'];
const LOCATION_TYPES = ['WAREHOUSE', 'PROJECT_SITE'];

async function createItem(payload, actorUserId, transaction) {
  const { groupId, companyId, name, unitOfMeasure, itemType, sku, minimumQuantity } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'INVENTORY_ITEM_VALIDATION');
  }
  if (itemType && !ITEM_TYPES.includes(itemType)) {
    throw AppError.badRequest(`"itemType" precisa ser um de: ${ITEM_TYPES.join(', ')}.`, 'INVENTORY_ITEM_VALIDATION');
  }
  if (minimumQuantity != null && (!Number.isFinite(Number(minimumQuantity)) || Number(minimumQuantity) < 0)) {
    throw AppError.badRequest('"minimumQuantity" precisa ser um número >= 0.', 'INVENTORY_ITEM_VALIDATION');
  }

  const item = await InventoryItem.create(
    {
      groupId,
      companyId,
      sku: sku || null,
      name,
      unitOfMeasure: unitOfMeasure || null,
      itemType: itemType || 'CONSUMABLE',
      minimumQuantity: minimumQuantity != null ? minimumQuantity : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await publishItemCreated(item, transaction);
  return item;
}

async function listItems(transaction, { itemType } = {}) {
  const where = {};
  if (itemType) where.itemType = itemType;
  return InventoryItem.findAll({ where, order: [['name', 'ASC']], transaction });
}

async function getItem(itemId, transaction) {
  const item = await InventoryItem.findByPk(itemId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
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

module.exports = { ITEM_TYPES, LOCATION_TYPES, createItem, listItems, getItem, createLocation, listLocations };
