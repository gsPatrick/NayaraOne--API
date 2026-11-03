'use strict';

const { DataTypes } = require('sequelize');

/**
 * AccountingExportBatch — tabela "correspondent"."accounting_export_batches" (Marco 8 Fase 12).
 * Export contábil sempre por batch com hash (citação literal do Caderno).
 */
module.exports = (sequelize) => {
  const AccountingExportBatch = sequelize.define(
    'AccountingExportBatch',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      referencePeriod: { type: DataTypes.STRING(7), allowNull: false, field: 'reference_period' },
      batchHash: { type: DataTypes.STRING(64), allowNull: false, field: 'batch_hash' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'EXPORTED' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'accounting_export_batches',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return AccountingExportBatch;
};
