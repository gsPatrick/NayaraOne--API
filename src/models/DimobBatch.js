'use strict';

const { DataTypes } = require('sequelize');

/**
 * DimobBatch — tabela "correspondent"."dimob_batches" (Marco 8 Fase 12). Dataset anual por
 * empresa, snapshot/hash reproduzível (gerar 2x com a mesma entrada produz o mesmo hash), layout
 * anual versionado — correção por NOVA versão, nunca sobrescreve um batch já fechado (citação
 * literal do Caderno).
 */
module.exports = (sequelize) => {
  const DimobBatch = sequelize.define(
    'DimobBatch',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      referenceYear: { type: DataTypes.INTEGER, allowNull: false, field: 'reference_year' },
      layoutVersion: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DIMOB-2026-v1', field: 'layout_version' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT' },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: false, field: 'snapshot_hash' },
      fileModelJson: { type: DataTypes.JSONB, allowNull: true, field: 'file_model_json' },
      fileModelHash: { type: DataTypes.STRING(64), allowNull: true, field: 'file_model_hash' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'dimob_batches',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return DimobBatch;
};
