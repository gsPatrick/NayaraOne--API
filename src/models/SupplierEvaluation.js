'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SupplierEvaluation = sequelize.define(
    'SupplierEvaluation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      supplierPersonId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_person_id' },
      purchaseOrderId: { type: DataTypes.UUID, allowNull: true, field: 'purchase_order_id' },
      score: { type: DataTypes.INTEGER, allowNull: false, field: 'score' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { schema: 'procurement', tableName: 'supplier_evaluations', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return SupplierEvaluation;
};
