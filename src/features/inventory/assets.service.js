'use strict';

const { Asset, AssetMovement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishAssetTransferred } = require('./inventoryEvents.service');

// Caderno §9/Guia §9: patrimônio individualizável, asset_tag UNIQUE (EST-TS-04), QR só carrega
// identificador opaco (GET /assets/by-tag/:tag), toda transferência gera asset_movement.
async function createAsset(payload, actorUserId, transaction) {
  const { groupId, companyId, assetTag, name, inventoryItemId, currentLocationId, assignedToUserId, projectId, acquisitionValue, acquiredAt, warrantyUntil } = payload;

  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'ASSET_VALIDATION');
  }

  if (assetTag) {
    const existing = await Asset.findOne({ where: { assetTag }, transaction });
    if (existing) throw AppError.badRequest(`"assetTag" "${assetTag}" já está em uso (EST-TS-04).`, 'ASSET_DUPLICATE_TAG');
  }

  return Asset.create(
    {
      groupId,
      companyId,
      assetTag: assetTag || null,
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

module.exports = { createAsset, listAssets, getAssetByTag, transferAsset };
