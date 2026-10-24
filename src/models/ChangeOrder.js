'use strict';

const { DataTypes } = require('sequelize');

/**
 * ChangeOrder — tabela "construction"."change_orders"
 * Única forma de alterar valor de um orçamento já `APPROVED` (M6-06/M6-17/M6-33).
 */
module.exports = (sequelize) => {
  const ChangeOrder = sequelize.define(
    'ChangeOrder',
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
      reasonCode: { type: DataTypes.STRING(64), allowNull: false, field: 'reason_code' },
      description: { type: DataTypes.TEXT, allowNull: false, field: 'description' },
      budgetImpact: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'budget_impact' },
      scheduleImpactDays: { type: DataTypes.INTEGER, allowNull: true, field: 'schedule_impact_days' },
      evidenceFileIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'evidence_file_ids' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: true, field: 'idempotency_key' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      decidedBy: { type: DataTypes.UUID, allowNull: true, field: 'decided_by' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'change_orders',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return ChangeOrder;
};
