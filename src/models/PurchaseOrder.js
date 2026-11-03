'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PurchaseOrder = sequelize.define(
    'PurchaseOrder',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      purchaseRequestId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_request_id' },
      supplierOfferId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_offer_id' },
      supplierPersonId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_person_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      committedAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'committed_amount' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { schema: 'procurement', tableName: 'purchase_orders', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', version: 'lockVersion', underscored: true }
  );
  return PurchaseOrder;
};
