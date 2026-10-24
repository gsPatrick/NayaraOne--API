'use strict';

const { DataTypes } = require('sequelize');

/**
 * AccountingReturnImport — tabela "correspondent"."accounting_return_imports" (Marco 8 Fase 12).
 * Registro do retorno do contador importado de volta — insumo usado pela reconciliação.
 */
module.exports = (sequelize) => {
  const AccountingReturnImport = sequelize.define(
    'AccountingReturnImport',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      referencePeriod: { type: DataTypes.STRING(7), allowNull: false, field: 'reference_period' },
      fileName: { type: DataTypes.STRING(255), allowNull: true, field: 'file_name' },
      summaryJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'summary_json' },
      importedBy: { type: DataTypes.UUID, allowNull: true, field: 'imported_by' },
      importedAt: { type: DataTypes.DATE, allowNull: false, field: 'imported_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'accounting_return_imports',
      timestamps: false,
      underscored: true,
    }
  );
  return AccountingReturnImport;
};
