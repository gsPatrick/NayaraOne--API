'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationInbox — tabela "integration"."integration_inbox"
 * Inbox de deduplicação de consumo de eventos/webhooks externos.
 */
module.exports = (sequelize) => {
  const IntegrationInbox = sequelize.define(
    'IntegrationInbox',
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
      consumerName: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'consumer_name',
      },
      eventId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'event_id',
      },
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: false,
        unique: true,
        field: 'idempotency_key',
      },
      payloadJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'payload_json',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'RECEIVED',
        field: 'status',
        comment: "RECEIVED|PROCESSING|PROCESSED|FAILED|DEAD",
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
      tableName: 'integration_inbox',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return IntegrationInbox;
};
