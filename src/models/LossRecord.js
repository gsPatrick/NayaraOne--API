'use strict';

const { DataTypes } = require('sequelize');

/**
 * LossRecord — tabela "construction"."loss_records"
 * Perda/quebra de material de obra, com aprovação por alçada (M6-14/M6-29) e suporte a
 * devolução via movimento inverso (`movement_type=RETURN`, M6-28/M6-60).
 */
module.exports = (sequelize) => {
  const LossRecord = sequelize.define(
    'LossRecord',
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
      materialDescription: { type: DataTypes.STRING(255), allowNull: false, field: 'material_description' },
      quantity: { type: DataTypes.DECIMAL(18, 3), allowNull: false, field: 'quantity' },
      estimatedValue: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'estimated_value' },
      reason: { type: DataTypes.TEXT, allowNull: false, field: 'reason' },
      movementType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'LOSS',
        field: 'movement_type',
        comment: 'LOSS|RETURN',
      },
      relatedLossRecordId: { type: DataTypes.UUID, allowNull: true, field: 'related_loss_record_id' },
      status: {
        type: DataTypes.STRING(24),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'status',
        comment: 'DRAFT|PENDING_APPROVAL|APPROVED',
      },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: true, field: 'idempotency_key' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'loss_records',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return LossRecord;
};
