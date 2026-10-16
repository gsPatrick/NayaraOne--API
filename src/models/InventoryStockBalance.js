'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryStockBalance — tabela "inventory"."stock_balances"
 * Saldo de um item em um local, derivado exclusivamente de movimentos (nunca digitável, EST-002).
 */
module.exports = (sequelize) => {
  const InventoryStockBalance = sequelize.define(
    'InventoryStockBalance',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: false, field: 'inventory_item_id' },
      locationId: { type: DataTypes.UUID, allowNull: false, field: 'location_id' },
      quantityOnHand: {
        type: DataTypes.DECIMAL(14, 6),
        allowNull: false,
        defaultValue: 0,
        field: 'quantity_on_hand',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
    },
    {
      schema: 'inventory',
      tableName: 'stock_balances',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryStockBalance;
};
