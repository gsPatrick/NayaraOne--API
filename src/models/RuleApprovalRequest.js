'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleApprovalRequest — tabela "core"."rule_approval_requests"
 * Solicitação de aprovação segregada para publicação de uma versão de regra (quem cria não é o único aprovador).
 */
module.exports = (sequelize) => {
  const RuleApprovalRequest = sequelize.define(
    'RuleApprovalRequest',
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
      ruleVersionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'rule_version_id',
      },
      requestedByUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'requested_by_user_id',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
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
      tableName: 'rule_approval_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleApprovalRequest;
};
