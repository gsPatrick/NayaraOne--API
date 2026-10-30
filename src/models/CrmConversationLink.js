'use strict';

const { DataTypes } = require('sequelize');

/** CrmConversationLink — "crm"."conversation_links" (Marco 9, M9-D230 3.5): o par externo (connection, id no fornecedor) de uma conversa ou canal interno; `superseded_at` marca o par que a troca de fornecedor substituiu. */
module.exports = (sequelize) => sequelize.define(
  'CrmConversationLink',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    internalId: { type: DataTypes.UUID, allowNull: false, field: 'internal_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    externalId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_id' },
    supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
  },
  { schema: 'crm', tableName: 'conversation_links', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
