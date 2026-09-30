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
        defaultValue: 'DRAFT',
        field: 'status',
        comment: 'DRAFT|SUBMITTED|REVIEWED|APPROVED|PAYABLE|REJECTED|SUPERSEDED',
      },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      rejectionReason: { type: DataTypes.TEXT, allowNull: true, field: 'rejection_reason' },
      submittedAt: { type: DataTypes.DATE, allowNull: true, field: 'submitted_at' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      reviewNotes: { type: DataTypes.TEXT, allowNull: true, field: 'review_notes' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'total_amount' },
      payableFinancialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'payable_financial_entry_id' },
      parentMeasurementId: { type: DataTypes.UUID, allowNull: true, field: 'parent_measurement_id' },
      revisionNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'revision_number' },
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
