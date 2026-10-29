'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationDispatch — "integration"."dispatches" (Marco 9, M9-D205): a intenção local de uma chamada externa,
 * gravada ANTES de ela sair, com o conteúdo aprovado (snapshot), seu hash e a chave de idempotência.
 */
module.exports = (sequelize) => sequelize.define(
  'IntegrationDispatch',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
    operation: { type: DataTypes.STRING(64), allowNull: false },
    outboxEventId: { type: DataTypes.UUID, allowNull: true, field: 'outbox_event_id' },
    aggregateType: { type: DataTypes.STRING(128), allowNull: true, field: 'aggregate_type' },
    aggregateId: { type: DataTypes.UUID, allowNull: true, field: 'aggregate_id' },
    status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: 'PENDING' },
    criticalityOp: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'DANGEROUS', field: 'criticality_op' },
    payloadSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'payload_snapshot' },
    payloadHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'payload_hash' },
    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: 'idempotency_key' },
    externalRequestId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_request_id' },
    externalResourceId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_resource_id' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, field: 'max_attempts' },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'next_attempt_at' },
    lastErrorClass: { type: DataTypes.STRING(12), allowNull: true, field: 'last_error_class' },
    lastErrorCode: { type: DataTypes.STRING(64), allowNull: true, field: 'last_error_code' },
    lastHttpStatus: { type: DataTypes.INTEGER, allowNull: true, field: 'last_http_status' },
    confirmedAt: { type: DataTypes.DATE, allowNull: true, field: 'confirmed_at' },
    unknownSince: { type: DataTypes.DATE, allowNull: true, field: 'unknown_since' },
    reconcileAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'reconcile_attempts' },
    correlationId: { type: DataTypes.UUID, allowNull: true, field: 'correlation_id' },
    purpose: { type: DataTypes.STRING(48), allowNull: true },
    fieldsDropped: { type: DataTypes.INTEGER, allowNull: true, field: 'fields_dropped' },
    confirmationMode: { type: DataTypes.STRING(12), allowNull: true, field: 'confirmation_mode' },
    externalStatus: { type: DataTypes.STRING(64), allowNull: true, field: 'external_status' },
    essential: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    submittedAt: { type: DataTypes.DATE, allowNull: true, field: 'submitted_at' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
  },
  { schema: 'integration', tableName: 'dispatches', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
