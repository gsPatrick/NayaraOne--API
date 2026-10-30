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
        field: 'external_message_id',
        comment: "ID do provedor — usado para deduplicação de webhook",
      },
      connectionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'connection_id',
        comment: "M9-D229: connection de mensageria que enviou ou recebeu; com external_message_id é único (UNIQUE parcial)",
      },
      dispatchId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'dispatch_id',
        comment: "M9-D229: envio (integration.dispatches) que levou a mensagem ao fornecedor",
      },
      deliveryStatus: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'delivery_status',
        comment: "M9-D229: QUEUED|SENT|DELIVERED|READ|FAILED, só por evidência (webhook ou consulta), nunca pelo HTTP 200 do envio",
      },
      conversationId: { type: DataTypes.UUID, allowNull: true, field: 'conversation_id' },
      mediaQuarantineId: { type: DataTypes.UUID, allowNull: true, field: 'media_quarantine_id' },
      mediaState: { type: DataTypes.STRING(16), allowNull: true, field: 'media_state' },
      failureReason: { type: DataTypes.STRING(240), allowNull: true, field: 'failure_reason' },
      alternateChannel: { type: DataTypes.STRING(48), allowNull: true, field: 'alternate_channel', comment: 'M9-D227: EMAIL ou o outro fornecedor de mensagens que levou a mensagem com o WhatsApp principal fora' },
      alternateRef: { type: DataTypes.STRING(64), allowNull: true, field: 'alternate_ref' },
      alternateAt: { type: DataTypes.DATE, allowNull: true, field: 'alternate_at' },
      actionKey: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'action_key',
        comment: "M9-D415: chave de idempotência da ação de automação que gerou o registro (UNIQUE por empresa)",
      },
      purpose: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'purpose',
        comment: "M9-D416: finalidade da mensagem automática (conta no frequency cap por pessoa, canal e finalidade); nulo = não automática",
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
