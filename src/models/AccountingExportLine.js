'use strict';

const { DataTypes } = require('sequelize');

/**
 * AccountingExportLine — tabela "correspondent"."accounting_export_lines" (Marco 8 Fase 12).
 * `adjustmentOfLineId` aponta pra uma linha anterior quando esta é um AJUSTE — nunca edita a
 * linha original (citação literal do Caderno: "ajustes auditados, nunca edição direta de linha
 * já exportada"), mesmo padrão de chargeback de comissão (Fase 8).
 */
module.exports = (sequelize) => {
  const AccountingExportLine = sequelize.define(
    'AccountingExportLine',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      batchId: { type: DataTypes.UUID, allowNull: false, field: 'batch_id' },
      sourceType: { type: DataTypes.STRING(32), allowNull: false, field: 'source_type' },
      sourceId: { type: DataTypes.UUID, allowNull: false, field: 'source_id' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false },
      adjustmentOfLineId: { type: DataTypes.UUID, allowNull: true, field: 'adjustment_of_line_id' },
    },
    {
      schema: 'correspondent',
      tableName: 'accounting_export_lines',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return AccountingExportLine;
};
