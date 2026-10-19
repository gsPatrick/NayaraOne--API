'use strict';

const { DataTypes } = require('sequelize');

/**
 * CollectionCadenceStep — tabela "finance"."collection_cadence_steps". Uma linha por etapa da
 * régua de cobrança (REG-LOC-004) executada ou pulada para uma competência. Append-only (trigger
 * de banco); UNIQUE (billing_schedule_id, step_code).
 */
module.exports = (sequelize) => {
  const CollectionCadenceStep = sequelize.define(
    'CollectionCadenceStep',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      billingScheduleId: { type: DataTypes.UUID, allowNull: false, field: 'billing_schedule_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      ruleVersionId: { type: DataTypes.UUID, allowNull: false, field: 'rule_version_id' },
      stepCode: { type: DataTypes.STRING(40), allowNull: false, field: 'step_code' },
      offsetDays: { type: DataTypes.INTEGER, allowNull: false, field: 'offset_days' },
      action: { type: DataTypes.STRING(32), allowNull: false, field: 'action' },
      outcome: { type: DataTypes.STRING(32), allowNull: false, field: 'outcome' },
      businessDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'business_date' },
      daysFromDue: { type: DataTypes.INTEGER, allowNull: false, field: 'days_from_due' },
      balanceAtStep: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'balance_at_step' },
      notificationId: { type: DataTypes.UUID, allowNull: true, field: 'notification_id' },
      taskId: { type: DataTypes.UUID, allowNull: true, field: 'task_id' },
    },
    {
      schema: 'finance',
      tableName: 'collection_cadence_steps',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return CollectionCadenceStep;
};
