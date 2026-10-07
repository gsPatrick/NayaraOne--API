'use strict';

const { Asset, AssetMovement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishAssetTransferred } = require('./inventoryEvents.service');

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): createAsset/updateAsset
// não validavam acquisitionValue (TAB-0760: purchase_value numeric(18,2)) — aceitavam negativo
// sem nenhuma checagem, diferente do mesmo tipo de campo monetário em budgetLines/changeOrders.
function assertNonNegativeAcquisitionValue(value) {
  if (value == null) return;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw AppError.badRequest('"acquisitionValue" deve ser um número maior ou igual a zero.', 'ASSET_VALIDATION');
  }
}

// Caderno §9/Guia §9: patrimônio individualizável, asset_tag UNIQUE (EST-TS-04), QR só carrega
// identificador opaco (GET /assets/by-tag/:tag), toda transferência gera asset_movement.
// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 47, 2026-10-05): o contrato (TAB-0760)
// trata "asset_tag" (QR/etiqueta) como NOT NULL com UNIQUE(company_id, asset_tag) — mas era
// possível cadastrar patrimônio sem tag, e a checagem de duplicidade não era escopada por
// empresa (bloqueava reaproveitar a mesma tag física em empresas distintas do mesmo tenant).
async function createAsset(payload, actorUserId, transaction) {
  const { groupId, companyId, assetTag, name, inventoryItemId, currentLocationId, assignedToUserId, projectId, acquisitionValue, acquiredAt, warrantyUntil } = payload;

  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'ASSET_VALIDATION');
  }
  if (!assetTag) {
    throw AppError.badRequest('O campo "assetTag" é obrigatório (QR/etiqueta — TAB-0760).', 'ASSET_VALIDATION');
  }
  assertNonNegativeAcquisitionValue(acquisitionValue);

  const existing = await Asset.findOne({ where: { companyId, assetTag }, transaction });
  if (existing) throw AppError.badRequest(`"assetTag" "${assetTag}" já está em uso nesta empresa (EST-TS-04).`, 'ASSET_DUPLICATE_TAG');

  return Asset.create(
    {
      groupId,
      companyId,
      assetTag,
      name,
      inventoryItemId: inventoryItemId || null,
      currentLocationId: currentLocationId || null,
      assignedToUserId: assignedToUserId || null,
      projectId: projectId || null,
      acquisitionValue: acquisitionValue != null ? acquisitionValue : null,
      acquiredAt: acquiredAt || null,
      warrantyUntil: warrantyUntil || null,
      status: 'AVAILABLE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listAssets(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return Asset.findAll({ where, order: [['name', 'ASC']], transaction });
}

async function getAssetByTag(assetTag, transaction) {
  const asset = await Asset.findOne({ where: { assetTag }, transaction });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado para este QR Code.', 'ASSET_NOT_FOUND');
  return asset;
}

async function transferAsset(assetId, payload, actorUserId, transaction) {
  const { destinationLocationId, destinationCustodianUserId, idempotencyKey } = payload;
  if (!destinationLocationId && !destinationCustodianUserId) {
    throw AppError.badRequest('Informe "destinationLocationId" e/ou "destinationCustodianUserId".', 'ASSET_TRANSFER_VALIDATION');
  }

  if (idempotencyKey) {
    const existing = await AssetMovement.findOne({ where: { idempotencyKey }, transaction });
    if (existing) return existing;
  }

  // EST-TS-15: transferência concorrente usa lock otimista (lockVersion do Asset) — o save()
  // abaixo falha com erro de versão se outra transação já alterou o asset no meio do caminho.
  const asset = await Asset.findByPk(assetId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');

  const movement = await AssetMovement.create(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      assetId: asset.id,
      sourceLocationId: asset.currentLocationId,
      destinationLocationId: destinationLocationId || asset.currentLocationId,
      sourceCustodianUserId: asset.assignedToUserId,
      destinationCustodianUserId: destinationCustodianUserId || asset.assignedToUserId,
      idempotencyKey: idempotencyKey || null,
      movedAt: new Date(),
      movedByUserId: actorUserId || null,
    },
    { transaction }
  );

  if (destinationLocationId) asset.currentLocationId = destinationLocationId;
  if (destinationCustodianUserId) asset.assignedToUserId = destinationCustodianUserId;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await publishAssetTransferred(movement, transaction);

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'ASSET_TRANSFERRED', entityType: 'Asset', entityId: asset.id, reason: 'Transferência de patrimônio registrada.' },
    transaction
  );

  return movement;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 50, 2026-10-05): o contrato (Caderno
// §9) lista explicitamente "Asset possui aquisição, valor, localização, custodiante, garantia,
// status e manutenção" — mas não existia NENHUMA forma de editar acquiredAt/warrantyUntil
// depois da criação (nem endpoint, nem função de service). Um patrimônio cadastrado sem essa
// informação (comum — a nota fiscal/garantia muitas vezes chega depois) nunca podia ser
// corrigido.
async function updateAsset(id, payload, actorUserId, transaction) {
  const { name, acquisitionValue, acquiredAt, warrantyUntil } = payload;
  const asset = await Asset.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');

  if (acquisitionValue !== undefined) assertNonNegativeAcquisitionValue(acquisitionValue);

  const beforeJson = asset.toJSON();
  if (name !== undefined) asset.name = name;
  if (acquisitionValue !== undefined) asset.acquisitionValue = acquisitionValue;
  if (acquiredAt !== undefined) asset.acquiredAt = acquiredAt;
  if (warrantyUntil !== undefined) asset.warrantyUntil = warrantyUntil;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'ASSET_UPDATED', entityType: 'Asset', entityId: asset.id, beforeJson, afterJson: asset.toJSON(), reason: 'Patrimônio atualizado.' },
    transaction
  );

  return asset;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 52, 2026-10-05): o contrato
// (inventory.asset_movements — "Transferências/localização") exige rastrear o histórico de
// movimentações do patrimônio, e toda transferência já gera um AssetMovement (transferAsset
// acima) — mas não existia NENHUMA forma de ler esse histórico de volta, nem endpoint nem tela.
async function listAssetMovements(assetId, transaction) {
  return AssetMovement.findAll({ where: { assetId }, order: [['moved_at', 'DESC']], transaction });
}

module.exports = { createAsset, listAssets, getAssetByTag, transferAsset, updateAsset, listAssetMovements };
