'use strict';

const { DataTypes } = require('sequelize');

/**
 * Nonconformity — tabela "construction"."nonconformities"
 * Não conformidade (NC) estruturada de obra: severidade, SLA, evidência antes/depois e aceite
 * quando aplicável (M6-13/M6-24/M6-37/M6-38/M6-62/M6-78).
 */
module.exports = (sequelize) => {
  const Nonconformity = sequelize.define(
    'Nonconformity',
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
      projectStageId: { type: DataTypes.UUID, allowNull: true, field: 'project_stage_id' },
      severity: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
        field: 'severity',
        comment: 'LOW|MEDIUM|HIGH|CRITICAL',
      },
      description: { type: DataTypes.TEXT, allowNull: false, field: 'description' },
      responsibleUserId: { type: DataTypes.UUID, allowNull: true, field: 'responsible_user_id' },
      slaDueAt: { type: DataTypes.DATE, allowNull: true, field: 'sla_due_at' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
        comment: 'OPEN|CLOSED',
      },
      beforeEvidenceFileIds: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        allowNull: false,
        defaultValue: [],
        field: 'before_evidence_file_ids',
      },
      afterEvidenceFileIds: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        allowNull: false,
        defaultValue: [],
        field: 'after_evidence_file_ids',
      },
      requiresAcceptance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'requires_acceptance' },
      acceptedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'accepted_by_user_id' },
      closedAt: { type: DataTypes.DATE, allowNull: true, field: 'closed_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'nonconformities',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Nonconformity;
};
