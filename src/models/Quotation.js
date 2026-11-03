'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Quotation = sequelize.define(
    'Quotation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      purchaseRequestId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_request_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { schema: 'procurement', tableName: 'quotations', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return Quotation;
};
