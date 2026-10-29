'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationWebhookInbox — "integration"."webhook_inbox" (Marco 9, M9-D203): eventos externos autenticados,
 * gravados uma única vez por (fornecedor, id do evento) antes de qualquer processamento.
 */
module.exports = (sequelize) => sequelize.define(
  'IntegrationWebhookInbox',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: true, field: 'connection_id' },
    providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
    channel: { type: DataTypes.STRING(48), allowNull: true },
    externalEventId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_event_id' },
    eventType: { type: DataTypes.STRING(80), allowNull: true, field: 'event_type' },
    apiVersion: { type: DataTypes.STRING(16), allowNull: true, field: 'api_version' },
    signatureValid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'signature_valid' },
    payloadHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'payload_hash' },
    payloadRaw: { type: DataTypes.BLOB, allowNull: true, field: 'payload_raw' },
    payload: { type: DataTypes.JSONB, allowNull: true },
    headersJson: { type: DataTypes.JSONB, allowNull: true, field: 'headers_json' },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'RECEIVED' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'next_attempt_at' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'received_at' },
    processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
    deadLetterReason: { type: DataTypes.TEXT, allowNull: true, field: 'dead_letter_reason' },
    // M9-D212: ordem dos eventos (recurso do fornecedor, status normalizado, posição na ordem e se o evento foi aplicado ao domínio).
    resourceRef: { type: DataTypes.STRING(160), allowNull: true, field: 'resource_ref' },
    internalStatus: { type: DataTypes.STRING(48), allowNull: true, field: 'internal_status' },
    statusRank: { type: DataTypes.INTEGER, allowNull: true, field: 'status_rank' },
    applied: { type: DataTypes.BOOLEAN, allowNull: true },
    correlationId: { type: DataTypes.UUID, allowNull: true, field: 'correlation_id' },
  },
  { schema: 'integration', tableName: 'webhook_inbox', timestamps: false, underscored: true }
);
