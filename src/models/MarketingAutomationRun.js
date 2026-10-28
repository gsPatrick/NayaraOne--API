'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingAutomationRun — tabela "marketing"."automation_runs".
 * Execução de uma versão de automação (M9-D401), idempotente por (empresa, idempotency_key). WAITING guarda ações agendadas em actions_result e o vencimento em next_due_at.
 */
module.exports = (sequelize) => {
  const MarketingAutomationRun = sequelize.define(
    'MarketingAutomationRun',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      automationVersionId: { type: DataTypes.UUID, allowNull: false, field: 'automation_version_id' },
      triggerEventId: { type: DataTypes.STRING(160), allowNull: true, field: 'trigger_event_id' },
      subjectType: { type: DataTypes.STRING(40), allowNull: true, field: 'subject_type' },
      subjectId: { type: DataTypes.UUID, allowNull: true, field: 'subject_id' },
      correlationId: { type: DataTypes.UUID, allowNull: false, field: 'correlation_id' },
      idempotencyKey: { type: DataTypes.STRING(300), allowNull: false, field: 'idempotency_key' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'STARTED', field: 'status' },
      blockedReason: { type: DataTypes.STRING(200), allowNull: true, field: 'blocked_reason' },
      policyTrace: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'policy_trace' },
      nextDueAt: { type: DataTypes.DATE, allowNull: true, field: 'next_due_at' },
      actionsResult: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'actions_result' },
      startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'automation_runs',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingAutomationRun;
};
