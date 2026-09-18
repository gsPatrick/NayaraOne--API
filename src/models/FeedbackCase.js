'use strict';

const { DataTypes } = require('sequelize');

/**
 * FeedbackCase — tabela "crm"."feedback_cases" (M3-20).
 * Reclamação (COMPLAINT), elogio (COMPLIMENT) ou conflito (CONFLICT) de um cliente, com SLA
 * calculado na criação a partir da severity e escalonamento (manual ou automático via
 * src/engines/jobs/feedbackCaseAlertJob.js).
 */
module.exports = (sequelize) => {
  const FeedbackCase = sequelize.define(
    'FeedbackCase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      opportunityId: { type: DataTypes.UUID, allowNull: true, field: 'opportunity_id' },
      type: { type: DataTypes.STRING(16), allowNull: false, field: 'type', comment: 'COMPLAINT|COMPLIMENT|CONFLICT' },
      description: { type: DataTypes.TEXT, allowNull: false, field: 'description' },
      severity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'MEDIUM', field: 'severity' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: 'assigned_to_user_id' },
      slaDueAt: { type: DataTypes.DATE, allowNull: false, field: 'sla_due_at' },
      escalatedAt: { type: DataTypes.DATE, allowNull: true, field: 'escalated_at' },
      resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
      resolutionNotes: { type: DataTypes.TEXT, allowNull: true, field: 'resolution_notes' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'crm',
      tableName: 'feedback_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return FeedbackCase;
};
