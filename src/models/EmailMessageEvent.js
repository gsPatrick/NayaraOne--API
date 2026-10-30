'use strict';

const { DataTypes } = require('sequelize');

/** EmailMessageEvent — "integration"."email_message_events" (Marco 9, M9-D234): cada evento do provedor aplicado a uma mensagem (só se acrescenta). */
module.exports = (sequelize) => sequelize.define(
  'EmailMessageEvent',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    messageId: { type: DataTypes.UUID, allowNull: false, field: 'message_id' },
    inboxId: { type: DataTypes.UUID, allowNull: true, field: 'inbox_id' },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    previousStatus: { type: DataTypes.STRING(16), allowNull: true, field: 'previous_status' },
    bounceType: { type: DataTypes.STRING(8), allowNull: true, field: 'bounce_type' },
    detail: { type: DataTypes.STRING(300), allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: true, field: 'occurred_at' },
  },
  { schema: 'integration', tableName: 'email_message_events', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
