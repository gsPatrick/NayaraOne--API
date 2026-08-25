'use strict';

const { DataTypes } = require('sequelize');

/**
 * StageMeasurement — tabela "construction"."stage_measurements"
 * Histórico formal de medição de uma etapa de obra, com workflow de aprovação (append-only).
 */
module.exports = (sequelize) => {
  const StageMeasurement = sequelize.define(
    'StageMeasurement',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectStageId: { type: DataTypes.UUID, allowNull: false, field: 'project_stage_id' },
      measuredPct: { type: DataTypes.DECIMAL(9, 6), allowNull: false, field: 'measured_pct' },
      measuredAt: { type: DataTypes.DATEONLY, allowNull: false, field: 'measured_at' },
      measuredByUserId: { type: DataTypes.UUID, allowNull: true, field: 'measured_by_user_id' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING_APPROVAL',
        field: 'status',
        comment: 'PENDING_APPROVAL|APPROVED|REJECTED',
      },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      rejectionReason: { type: DataTypes.TEXT, allowNull: true, field: 'rejection_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'construction',
      tableName: 'stage_measurements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return StageMeasurement;
};
