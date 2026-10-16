'use strict';

const { DataTypes } = require('sequelize');

/**
 * StageDependency — tabela "construction"."stage_dependencies"
 * Dependência entre etapas de obra: `stageId` só pode avançar depois que `dependsOnStageId`
 * estiver concluída. Validação de ausência de ciclo é feita em
 * `src/features/construction/stageDependencies.service.js` (DFS no grafo antes do INSERT).
 */
module.exports = (sequelize) => {
  const StageDependency = sequelize.define(
    'StageDependency',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      stageId: { type: DataTypes.UUID, allowNull: false, field: 'stage_id' },
      dependsOnStageId: { type: DataTypes.UUID, allowNull: false, field: 'depends_on_stage_id' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'stage_dependencies',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return StageDependency;
};
