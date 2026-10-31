'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryReceipt — tabela "inventory"."receipts"
 * Recebimento de material vinculado a NF/fornecedor (DRAFT -> REVIEWED -> COMPLETED).
 */
module.exports = (sequelize) => {
  const InventoryReceipt = sequelize.define(
    'InventoryReceipt',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      destinationLocationId: { type: DataTypes.UUID, allowNull: false, field: 'destination_location_id' },
      supplierPersonId: { type: DataTypes.UUID, allowNull: true, field: 'supplier_person_id' },
      invoiceNumber: { type: DataTypes.STRING(64), allowNull: true, field: 'invoice_number' },
      invoiceFingerprint: { type: DataTypes.STRING(128), allowNull: true, field: 'invoice_fingerprint' },
      invoiceFileId: { type: DataTypes.UUID, allowNull: true, field: 'invoice_file_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'receipts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryReceipt;
};
