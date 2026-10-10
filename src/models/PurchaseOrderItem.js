'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PurchaseOrderItem = sequelize.define(
    'PurchaseOrderItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      purchaseOrderId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_order_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: true, field: 'inventory_item_id' },
      description: { type: DataTypes.STRING(255), allowNull: false, field: 'description' },
      quantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'quantity' },
      unitPrice: { type: DataTypes.DECIMAL(18, 6), allowNull: false, field: 'unit_price' },
      receivedQuantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, defaultValue: 0, field: 'received_quantity' },
    },
    { schema: 'procurement', tableName: 'purchase_order_items', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return PurchaseOrderItem;
};
