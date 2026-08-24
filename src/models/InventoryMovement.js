'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryMovement — tabela "inventory"."inventory_movements"
 * Movimentação append-only de entrada/saída de um item de estoque.
 */
module.exports = (sequelize) => {
  const InventoryMovement = sequelize.define(
    'InventoryMovement',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      inventoryItemId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'inventory_item_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'project_id',
      },
      movementType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'movement_type',
        comment: "IN|OUT|TRANSFER",
      },
      quantity: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: false,
        field: 'quantity',
      },
      movedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'moved_at',
      },
      movedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'moved_by_user_id',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'inventory',
      tableName: 'inventory_movements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryMovement;
};
