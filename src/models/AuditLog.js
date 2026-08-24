'use strict';

const { DataTypes } = require('sequelize');

/**
 * AuditLog — tabela "audit"."audit_log"
 * Trilha de auditoria append-only — nunca UPDATE/DELETE por usuário comum.
 */
module.exports = (sequelize) => {
  const AuditLog = sequelize.define(
    'AuditLog',
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
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'user_id',
      },
      action: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'action',
      },
      entityType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'entity_type',
      },
      entityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'entity_id',
      },
      beforeJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'before_json',
      },
      afterJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'after_json',
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'reason',
      },
      occurredAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'occurred_at',
      },
      sessionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'session_id',
      },
      ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'ip_address',
      },
      correlationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'correlation_id',
      },
      ruleVersionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'rule_version_id',
        comment: "Versão da regra vigente no momento da ação, quando aplicável",
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
      schema: 'audit',
      tableName: 'audit_log',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AuditLog;
};
