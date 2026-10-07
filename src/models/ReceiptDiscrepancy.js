'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ReceiptDiscrepancy = sequelize.define(
    'ReceiptDiscrepancy',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      goodsReceiptItemId: { type: DataTypes.UUID, allowNull: false, field: 'goods_receipt_item_id' },
      discrepancyType: { type: DataTypes.STRING(32), allowNull: false, field: 'discrepancy_type' },
      expectedValue: { type: DataTypes.DECIMAL(18, 6), allowNull: true, field: 'expected_value' },
      receivedValue: { type: DataTypes.DECIMAL(18, 6), allowNull: true, field: 'received_value' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      resolutionNotes: { type: DataTypes.TEXT, allowNull: true, field: 'resolution_notes' },
      resolvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'resolved_by_user_id' },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
    },
    { schema: 'procurement', tableName: 'receipt_discrepancies', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return ReceiptDiscrepancy;
};
