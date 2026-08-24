'use strict';

const { DataTypes } = require('sequelize');

/**
 * DomainEvent — tabela "integration"."domain_events"
 * Registro append-only do histórico de eventos de domínio já processados internamente (auditoria de fluxo, não é o outbox de transporte).
 */
module.exports = (sequelize) => {
  const DomainEvent = sequelize.define(
    'DomainEvent',
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
      payloadJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'payload_json',
      },
      occurredAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'occurred_at',
      },
      correlationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'correlation_id',
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
      tableName: 'domain_events',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return DomainEvent;
};
