'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PurchaseRequestItem = sequelize.define(
    'PurchaseRequestItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      purchaseRequestId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_request_id' },
      inventoryItemId: { type: DataTypes.UUID, allowNull: true, field: 'inventory_item_id' },
      description: { type: DataTypes.STRING(255), allowNull: false, field: 'description' },
      quantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'quantity' },
    },
    { schema: 'procurement', tableName: 'purchase_request_items', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return PurchaseRequestItem;
};
