'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SupplierOfferItem = sequelize.define(
    'SupplierOfferItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      supplierOfferId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_offer_id' },
      purchaseRequestItemId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_request_item_id' },
      unitPrice: { type: DataTypes.DECIMAL(18, 6), allowNull: false, field: 'unit_price' },
    },
    { schema: 'procurement', tableName: 'supplier_offer_items', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return SupplierOfferItem;
};
