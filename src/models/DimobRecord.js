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
