'use strict';

const { DataTypes } = require('sequelize');

/**
 * DailyReport — tabela "construction"."daily_reports"
 * RDO (Relatório Diário de Obra) — um por projeto por dia.
 */
module.exports = (sequelize) => {
  const DailyReport = sequelize.define(
    'DailyReport',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectId: { type: DataTypes.UUID, allowNull: false, field: 'project_id' },
      reportDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'report_date' },
      weather: { type: DataTypes.STRING(32), allowNull: true, field: 'weather' },
      workforceCount: { type: DataTypes.INTEGER, allowNull: true, field: 'workforce_count' },
      occurrences: { type: DataTypes.TEXT, allowNull: true, field: 'occurrences' },
      reportedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reported_by_user_id' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'daily_reports',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return DailyReport;
};
