'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryLossCase — tabela "inventory"."loss_cases"
 * Perda/quebra/extravio (EST-010): não é baixa comum. OPEN -> APPROVED/REJECTED; só APPROVED
 * gera o movimento LOSS/DISPOSAL correspondente (resultingMovementId).
 */
module.exports = (sequelize) => {
  const InventoryLossCase = sequelize.define(
    'InventoryLossCase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: true, field: 'inventory_item_id' },
      assetId: { type: DataTypes.UUID, allowNull: true, field: 'asset_id' },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      projectId: { type: DataTypes.UUID, allowNull: true, field: 'project_id' },
      quantity: { type: DataTypes.DECIMAL(14, 6), allowNull: true, field: 'quantity' },
      responsiblePersonId: { type: DataTypes.UUID, allowNull: true, field: 'responsible_person_id' },
      context: { type: DataTypes.TEXT, allowNull: false, field: 'context' },
      evidenceFileIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'evidence_file_ids' },
      estimatedCost: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'estimated_cost' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      resultingMovementId: { type: DataTypes.UUID, allowNull: true, field: 'resulting_movement_id' },
      decidedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'decided_by_user_id' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'loss_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryLossCase;
};
