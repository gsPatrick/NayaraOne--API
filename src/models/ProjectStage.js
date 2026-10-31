'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProjectStage — tabela "construction"."project_stages"
 * Etapa/marco físico de uma obra, com medição associada (RDO).
 */
module.exports = (sequelize) => {
  const ProjectStage = sequelize.define(
    'ProjectStage',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'project_id',
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      // M6-02 (fechado 30/09/2026): identificador curto da etapa (ex.: "FUND-01") e custo
      // planejado — ambos opcionais, a spec não detalha um formato fixo.
      stageCode: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'stage_code',
      },
      plannedCost: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'planned_cost',
      },
      sequence: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'sequence',
      },
      plannedPct: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: true,
        field: 'planned_pct',
      },
      measuredPct: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: true,
        field: 'measured_pct',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'construction',
      tableName: 'project_stages',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return ProjectStage;
};
