'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryCountItem — tabela "inventory"."count_items"
 * Linha de contagem de um item dentro de um InventoryCount; expectedQuantity é travado no
 * fechamento (snapshot do saldo real naquele instante), divergence calculado no fechamento.
 */
module.exports = (sequelize) => {
  const InventoryCountItem = sequelize.define(
    'InventoryCountItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      countId: { type: DataTypes.UUID, allowNull: false, field: 'count_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: false, field: 'inventory_item_id' },
      expectedQuantity: { type: DataTypes.DECIMAL(14, 6), allowNull: true, field: 'expected_quantity' },
      countedQuantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'counted_quantity' },
      divergence: { type: DataTypes.DECIMAL(14, 6), allowNull: true, field: 'divergence' },
      adjustmentMovementId: { type: DataTypes.UUID, allowNull: true, field: 'adjustment_movement_id' },
    },
    {
      schema: 'inventory',
      tableName: 'count_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryCountItem;
};
