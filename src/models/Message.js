'use strict';

const { DataTypes } = require('sequelize');

/**
 * Message — tabela "crm"."messages"
 * Mensagem de atendimento omnichannel (WhatsApp etc.), vinculada a uma pessoa/oportunidade.
 */
module.exports = (sequelize) => {
  const Message = sequelize.define(
    'Message',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'person_id',
      },
      opportunityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opportunity_id',
      },
      channel: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'WHATSAPP',
        field: 'channel',
      },
      direction: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'direction',
        comment: "INBOUND|OUTBOUND",
      },
      authorType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'author_type',
        comment: "CLIENT|NAY|EMPLOYEE",
      },
      authorUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'author_user_id',
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'body',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'RECEIVED',
        field: 'status',
      },
      externalMessageId: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
        field: 'external_message_id',
        comment: "ID do provedor — usado para deduplicação de webhook",
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
      schema: 'crm',
      tableName: 'messages',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Message;
};
