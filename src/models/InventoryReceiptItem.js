'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryReceiptItem — tabela "inventory"."receipt_items"
 * Linha de item recebido dentro de um InventoryReceipt.
 */
module.exports = (sequelize) => {
  const InventoryReceiptItem = sequelize.define(
    'InventoryReceiptItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      receiptId: { type: DataTypes.UUID, allowNull: false, field: 'receipt_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: false, field: 'inventory_item_id' },
      quantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'quantity' },
      unitCost: { type: DataTypes.DECIMAL(18, 6), allowNull: true, field: 'unit_cost' },
    },
    {
      schema: 'inventory',
      tableName: 'receipt_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryReceiptItem;
};
