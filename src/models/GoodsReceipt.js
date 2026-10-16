'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const GoodsReceipt = sequelize.define(
    'GoodsReceipt',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      purchaseOrderId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_order_id' },
      destinationLocationId: { type: DataTypes.UUID, allowNull: false, field: 'destination_location_id' },
      inventoryReceiptId: { type: DataTypes.UUID, allowNull: true, field: 'inventory_receipt_id' },
      invoiceFingerprint: { type: DataTypes.STRING(128), allowNull: true, field: 'invoice_fingerprint' },
      invoiceTotalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'invoice_total_amount' },
      financialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'financial_entry_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: true, field: 'idempotency_key' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { schema: 'procurement', tableName: 'goods_receipts', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return GoodsReceipt;
};
