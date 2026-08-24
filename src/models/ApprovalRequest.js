'use strict';

const { DataTypes } = require('sequelize');

/**
 * ApprovalRequest — tabela "finance"."approval_requests"
 * Solicitação de aprovação (maker-checker) para operações financeiras/críticas.
 */
module.exports = (sequelize) => {
  const ApprovalRequest = sequelize.define(
    'ApprovalRequest',
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
      relatedEntityType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'related_entity_type',
      },
      relatedEntityId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'related_entity_id',
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
      riskLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
        field: 'risk_level',
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
      tableName: 'approval_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ApprovalRequest;
};
