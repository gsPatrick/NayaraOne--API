'use strict';

const { DataTypes } = require('sequelize');

/**
 * EmailMessage — "integration"."email_messages" (Marco 9, M9-D234): a mensagem de e-mail do domínio, ligada ao envio do Dispatch Service. O identificador do provedor é
 * único por connection; o corpo não é guardado aqui.
 */
module.exports = (sequelize) => sequelize.define(
  'EmailMessage',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
    dispatchId: { type: DataTypes.UUID, allowNull: true, field: 'dispatch_id' },
    idempotencyKey: { type: DataTypes.STRING(160), allowNull: false, field: 'idempotency_key' },
    purpose: { type: DataTypes.STRING(60), allowNull: true },
    originType: { type: DataTypes.STRING(60), allowNull: true, field: 'origin_type' },
    originId: { type: DataTypes.STRING(64), allowNull: true, field: 'origin_id' },
    toAddresses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'to_addresses' },
    ccAddresses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'cc_addresses' },
    bccAddresses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'bcc_addresses' },
    replyTo: { type: DataTypes.STRING(254), allowNull: true, field: 'reply_to' },
    subject: { type: DataTypes.STRING(300), allowNull: false },
    attachments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    attachmentBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'attachment_bytes' },
    externalMessageId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_message_id' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'QUEUED' },
    bounceType: { type: DataTypes.STRING(8), allowNull: true, field: 'bounce_type' },
    failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
    sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
    deliveredAt: { type: DataTypes.DATE, allowNull: true, field: 'delivered_at' },
    lastEventAt: { type: DataTypes.DATE, allowNull: true, field: 'last_event_at' },
    requestedBy: { type: DataTypes.UUID, allowNull: true, field: 'requested_by' },
  },
  { schema: 'integration', tableName: 'email_messages', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
