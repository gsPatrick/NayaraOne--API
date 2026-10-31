'use strict';

const { DataTypes } = require('sequelize');

/**
 * DimobRecord — tabela "correspondent"."dimob_records" (Marco 8 Fase 12). Linha do dataset DIMOB,
 * com `sourceRefs` rastreáveis (nunca copia o dado de origem, só referencia).
 */
module.exports = (sequelize) => {
  const DimobRecord = sequelize.define(
    'DimobRecord',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      dimobBatchId: { type: DataTypes.UUID, allowNull: false, field: 'dimob_batch_id' },
      sourceRefs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'source_refs' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      recordType: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'CORRESPONDENT_COMMISSION', field: 'record_type' },
      validationStatus: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'VALID', field: 'validation_status' },
      validationIssues: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'validation_issues' },
      detailJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'detail_json' },
    },
    {
      schema: 'correspondent',
      tableName: 'dimob_records',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return DimobRecord;
};
