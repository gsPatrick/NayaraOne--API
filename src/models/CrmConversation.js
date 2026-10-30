'use strict';

const { DataTypes } = require('sequelize');

/** CrmConversation — "crm"."conversations" (Marco 9, M9-D230 3.5): a conversa da pessoa num canal, com id interno estável e o horário da última mensagem do cliente (a janela de atendimento). */
module.exports = (sequelize) => sequelize.define(
  'CrmConversation',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
    channel: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'WHATSAPP' },
    channelId: { type: DataTypes.UUID, allowNull: true, field: 'channel_id' },
    lastInboundAt: { type: DataTypes.DATE, allowNull: true, field: 'last_inbound_at' },
  },
  { schema: 'crm', tableName: 'conversations', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
