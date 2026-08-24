'use strict';

const { DataTypes } = require('sequelize');

/**
 * ApprovalStep — tabela "finance"."approval_steps"
 * Etapa individual de decisão dentro de uma solicitação de aprovação (segregação de função: quem cria não aprova).
 */
module.exports = (sequelize) => {
  const ApprovalStep = sequelize.define(
    'ApprovalStep',
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
      approvalRequestId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'approval_request_id',
      },
      approverUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'approver_user_id',
      },
      stepOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'step_order',
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
      schema: 'finance',
      tableName: 'approval_steps',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ApprovalStep;
};
