'use strict';

const { InventoryItem, InventoryLocation, InventoryMovement, Project } = require('../../models');
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

// F4 (auditoria Marco 7, Nayara, 14/10/2026): item e local não podiam ser editados depois de
// criados — nem erro nem UI, simplesmente não existia a ação. Permite editar nome, unidade e
// estoque mínimo sempre; SKU só pode mudar se o item ainda não tiver nenhum movimento registrado
// (SKU é referência externa usada em NF/requisição já confirmada — mudar depois quebraria
// rastreabilidade). itemType não é editável aqui de propósito: mudar o tipo de um item com saldo
// físico já lançado teria efeito colateral não óbvio (ex: SERVICE_ITEM não admite minimumQuantity).
async function updateItem(itemId, payload, actorUserId, groupId, companyId, transaction) {
  const item = await getItem(itemId, groupId, companyId, transaction);
  const { name, unitOfMeasure, minimumQuantity, sku } = payload;

  if (name !== undefined) {
    if (!name) throw AppError.badRequest('O campo "name" não pode ficar vazio.', 'INVENTORY_ITEM_VALIDATION');
    item.name = name;
  }
  if (unitOfMeasure !== undefined) {
    if (!unitOfMeasure) throw AppError.badRequest('O campo "unitOfMeasure" não pode ficar vazio.', 'INVENTORY_ITEM_VALIDATION');
    item.unitOfMeasure = unitOfMeasure;
  }
  if (minimumQuantity !== undefined) {
    if (minimumQuantity != null && (!Number.isFinite(Number(minimumQuantity)) || Number(minimumQuantity) < 0)) {
      throw AppError.badRequest('"minimumQuantity" precisa ser um número >= 0.', 'INVENTORY_ITEM_VALIDATION');
    }
    if (minimumQuantity != null && item.itemType === 'SERVICE_ITEM') {
      throw AppError.badRequest('Item do tipo "SERVICE_ITEM" não tem saldo físico — não admite estoque mínimo.', 'INVENTORY_ITEM_VALIDATION');
    }
    item.minimumQuantity = minimumQuantity;
  }
  if (sku !== undefined && sku !== item.sku) {
    if (!sku) throw AppError.badRequest('O campo "sku" não pode ficar vazio.', 'INVENTORY_ITEM_VALIDATION');
    const hasMovement = await InventoryMovement.findOne({ where: { inventoryItemId: item.id }, transaction });
    if (hasMovement) {
      throw AppError.badRequest('Este item já tem movimentação registrada — o SKU não pode mais ser alterado.', 'INVENTORY_ITEM_SKU_LOCKED');
    }
    const existing = await InventoryItem.findOne({ where: { companyId, sku, id: { [require('sequelize').Op.ne]: item.id } }, transaction });
    if (existing) {
      throw AppError.badRequest(`Já existe um item com o SKU "${sku}" nesta empresa.`, 'INVENTORY_ITEM_DUPLICATE_SKU');
    }
    item.sku = sku;
  }

  item.updatedBy = actorUserId || null;
  await item.save({ transaction });
  return item;
}

async function listItems(groupId, companyId, transaction, { itemType, status } = {}) {
  const where = { groupId, companyId };
  if (status && status !== 'ALL') where.status = status;
  else if (!status) where.status = 'ACTIVE';
  if (itemType) where.itemType = itemType;
  return InventoryItem.findAll({ where, order: [['name', 'ASC']], limit: 1500, transaction });
}

async function getItem(itemId, groupId, companyId, transaction) {
  const item = await InventoryItem.findOne({ where: { id: itemId, groupId, companyId }, transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  return item;
}

async function setItemStatus(itemId, status, actorUserId, groupId, companyId, transaction) {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw AppError.badRequest('"status" precisa ser "ACTIVE" ou "INACTIVE".', 'INVENTORY_ITEM_VALIDATION');
  }
  const item = await getItem(itemId, groupId, companyId, transaction);
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
  // BUG REAL CORRIGIDO (auditoria Nayara, Marco 7, F2): um local PROJECT_SITE (canteiro de obra)
  // podia ser criado sem vínculo de obra, tornando IMPOSSÍVEL transferir estoque pra ele depois —
  // recordMovement exige "projectId" (EST-004) pra qualquer movimento tocando PROJECT_SITE, mas
  // o formulário de movimento não tinha (nem deveria ter) esse campo: um canteiro pertence a UMA
  // obra fixa, decidida no cadastro do local, não escolhida a cada movimento.
  if (locationType === 'PROJECT_SITE' && !projectId) {
    throw AppError.badRequest('Local do tipo "obra" (PROJECT_SITE) exige a obra vinculada ("projectId").', 'INVENTORY_LOCATION_PROJECT_REQUIRED');
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

async function listLocations(groupId, companyId, transaction) {
  // Achado real (revalidação Marco 7 v2, Nayara): a lista não mostrava a obra vinculada ao
  // canteiro (campo existe no cadastro desde a correção de F2, mas a listagem nunca incluía a
  // relação). Include leve (só id+nome), não afeta volume/latência de forma relevante.
  return InventoryLocation.findAll({
    where: { groupId, companyId, isActive: true },
    include: [{ model: Project, as: 'project', attributes: ['id', 'name'], required: false }],
    order: [['name', 'ASC']],
    limit: 1500,
    transaction,
  });
}

async function getLocation(locationId, groupId, companyId, transaction) {
  const location = await InventoryLocation.findOne({ where: { id: locationId, groupId, companyId }, transaction });
  if (!location) throw AppError.notFound('Local de estoque não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
  return location;
}

// F4 (auditoria Marco 7): local também não podia ser editado. locationType não é editável aqui —
// mudar WAREHOUSE para PROJECT_SITE (ou vice-versa) depois de criado teria efeito colateral não
// óbvio em movimentos já lançados; se precisar mudar o tipo, criar um novo local.
async function updateLocation(locationId, payload, actorUserId, groupId, companyId, transaction) {
  const location = await getLocation(locationId, groupId, companyId, transaction);
  const { name, projectId } = payload;

  if (name !== undefined) {
    if (!name) throw AppError.badRequest('O campo "name" não pode ficar vazio.', 'INVENTORY_LOCATION_VALIDATION');
    location.name = name;
  }
  if (projectId !== undefined) {
    if (location.locationType === 'PROJECT_SITE' && !projectId) {
      throw AppError.badRequest('Local do tipo "canteiro de obra" precisa de uma obra vinculada.', 'INVENTORY_LOCATION_VALIDATION');
    }
    location.projectId = projectId || null;
  }

  location.updatedBy = actorUserId || null;
  await location.save({ transaction });
  return location;
}

module.exports = {
  ITEM_TYPES,
  LOCATION_TYPES,
  createItem,
  updateItem,
  listItems,
  getItem,
  setItemStatus,
  createLocation,
  updateLocation,
  getLocation,
  listLocations,
};
