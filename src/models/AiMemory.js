'use strict';

const { DataTypes } = require('sequelize');

/** AiMemory — tabela "ai"."memories" (M9-D009): fato operacional estruturado da NAY, com dono, escopo, origem, validade e estado. */
module.exports = (sequelize) => sequelize.define(
  'AiMemory',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    ownerUserId: { type: DataTypes.UUID, allowNull: true, field: 'owner_user_id' },
    memoryType: { type: DataTypes.STRING(30), allowNull: false, field: 'memory_type' },
    subjectType: { type: DataTypes.STRING(64), allowNull: true, field: 'subject_type' },
    subjectId: { type: DataTypes.STRING(128), allowNull: true, field: 'subject_id' },
    scope: { type: DataTypes.STRING(10), allowNull: false, field: 'scope' },
    agentCode: { type: DataTypes.STRING(64), allowNull: true, field: 'agent_code' },
    value: { type: DataTypes.JSONB, allowNull: false, field: 'value' },
    sourceType: { type: DataTypes.STRING(20), allowNull: false, field: 'source_type' },
    sourceId: { type: DataTypes.UUID, allowNull: false, field: 'source_id' },
    classification: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'INTERNAL', field: 'classification' },
    purpose: { type: DataTypes.STRING(300), allowNull: true, field: 'purpose' },
    validFrom: { type: DataTypes.DATE, allowNull: false, field: 'valid_from' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
    supersedesId: { type: DataTypes.UUID, allowNull: true, field: 'supersedes_id' },
    invalidatedBy: { type: DataTypes.UUID, allowNull: true, field: 'invalidated_by' },
    invalidatedAt: { type: DataTypes.DATE, allowNull: true, field: 'invalidated_at' },
    invalidationReason: { type: DataTypes.TEXT, allowNull: true, field: 'invalidation_reason' },
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'ai', tableName: 'memories', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
