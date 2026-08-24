'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleApprovalStep — tabela "core"."rule_approval_steps"
 * Etapa/decisão individual dentro de uma solicitação de aprovação de regra.
 */
module.exports = (sequelize) => {
  const RuleApprovalStep = sequelize.define(
    'RuleApprovalStep',
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
      ruleApprovalRequestId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'rule_approval_request_id',
      },
      approverUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'approver_user_id',
      },
      decision: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'decision',
        comment: "APPROVED|REJECTED",
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'decided_at',
      },
      comment: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'comment',
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
    },
    {
      schema: 'core',
      tableName: 'rule_approval_steps',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleApprovalStep;
};
