'use strict';

const { DataTypes } = require('sequelize');

/**
 * OutboxEvent — tabela "integration"."outbox_events"
 * Transactional Outbox — evento de domínio gravado na mesma transação do dado de negócio, publicado depois no broker.
 */
module.exports = (sequelize) => {
  const OutboxEvent = sequelize.define(
    'OutboxEvent',
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
      aggregateType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'aggregate_type',
      },
      aggregateId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'aggregate_id',
      },
      eventType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'event_type',
      },
      eventVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'event_version',
      },
      payloadJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'payload_json',
      },
      correlationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'correlation_id',
      },
      causationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'causation_id',
      },
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: false,
        unique: true,
        field: 'idempotency_key',
      },
      classification: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'classification',
        comment: "ex. TRANSIENT|VALIDATION|CONFLICT",
      },
      occurredAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'occurred_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      retryCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'retry_count',
      },
      nextRetryAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'next_retry_at',
      },
      deadLetterReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'dead_letter_reason',
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
      schema: 'integration',
      tableName: 'outbox_events',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return OutboxEvent;
};
