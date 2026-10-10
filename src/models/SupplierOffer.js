'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SupplierOffer = sequelize.define(
    'SupplierOffer',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      quotationId: { type: DataTypes.UUID, allowNull: false, field: 'quotation_id' },
      supplierPersonId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_person_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'RECEIVED', field: 'status' },
      totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'total_amount' },
    },
    { schema: 'procurement', tableName: 'supplier_offers', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return SupplierOffer;
};
