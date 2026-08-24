'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryItem — tabela "inventory"."inventory_items"
 * Item de estoque (material, insumo, ferramenta) mantido em depósito.
 */
module.exports = (sequelize) => {
  const InventoryItem = sequelize.define(
    'InventoryItem',
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
      sku: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'sku',
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      unitOfMeasure: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'unit_of_measure',
      },
      quantityOnHand: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: false,
        defaultValue: 0,
        field: 'quantity_on_hand',
      },
      minimumQuantity: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: true,
        field: 'minimum_quantity',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
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
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'inventory',
      tableName: 'inventory_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryItem;
};
