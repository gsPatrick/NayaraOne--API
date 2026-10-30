'use strict';

const { DataTypes } = require('sequelize');

/** EmailInboundMessage — "integration"."email_inbound_messages" (Marco 9, M9-D235): e-mail recebido, só com o texto mascarado; vínculo ao cliente/processo ou "não vinculado". */
module.exports = (sequelize) => sequelize.define(
  'EmailInboundMessage',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
    inboxId: { type: DataTypes.UUID, allowNull: true, field: 'inbox_id' },
    externalMessageId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_message_id' },
    fromAddress: { type: DataTypes.STRING(254), allowNull: true, field: 'from_address' },
    toAddresses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'to_addresses' },
    subject: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
    bodyMasked: { type: DataTypes.TEXT, allowNull: true, field: 'body_masked' },
    containsPii: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'contains_pii' },
    piiTypes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'pii_types' },
    panRedacted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'pan_redacted' },
    linkStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'UNLINKED', field: 'link_status' },
    linkKind: { type: DataTypes.STRING(10), allowNull: true, field: 'link_kind' },
    linkedEntityType: { type: DataTypes.STRING(60), allowNull: true, field: 'linked_entity_type' },
    linkedEntityId: { type: DataTypes.STRING(64), allowNull: true, field: 'linked_entity_id' },
    linkedEmailMessageId: { type: DataTypes.UUID, allowNull: true, field: 'linked_email_message_id' },
    linkedBy: { type: DataTypes.UUID, allowNull: true, field: 'linked_by' },
    linkedAt: { type: DataTypes.DATE, allowNull: true, field: 'linked_at' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'received_at' },
  },
  { schema: 'integration', tableName: 'email_inbound_messages', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
