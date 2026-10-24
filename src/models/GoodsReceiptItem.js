'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const GoodsReceiptItem = sequelize.define(
    'GoodsReceiptItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      goodsReceiptId: { type: DataTypes.UUID, allowNull: false, field: 'goods_receipt_id' },
      purchaseOrderItemId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_order_item_id' },
      receivedQuantity: { type: DataTypes.DECIMAL(14, 6), allowNull: false, field: 'received_quantity' },
    },
    { schema: 'procurement', tableName: 'goods_receipt_items', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return GoodsReceiptItem;
};
