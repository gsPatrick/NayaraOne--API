'use strict';

const { DataTypes } = require('sequelize');

/**
 * AssetMovement — tabela "inventory"."asset_movements"
 * Toda transferência de local/custodiante de um Asset gera um registro aqui — nunca é um
 * UPDATE mudo na tabela assets (item 9 do Caderno).
 */
module.exports = (sequelize) => {
  const AssetMovement = sequelize.define(
    'AssetMovement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      assetId: { type: DataTypes.UUID, allowNull: false, field: 'asset_id' },
      sourceLocationId: { type: DataTypes.UUID, allowNull: true, field: 'source_location_id' },
      destinationLocationId: { type: DataTypes.UUID, allowNull: true, field: 'destination_location_id' },
      sourceCustodianUserId: { type: DataTypes.UUID, allowNull: true, field: 'source_custodian_user_id' },
      destinationCustodianUserId: { type: DataTypes.UUID, allowNull: true, field: 'destination_custodian_user_id' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: true, field: 'idempotency_key' },
      movedAt: { type: DataTypes.DATE, allowNull: false, field: 'moved_at' },
      movedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'moved_by_user_id' },
    },
    {
      schema: 'inventory',
      tableName: 'asset_movements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AssetMovement;
};
