'use strict';

const { DataTypes } = require('sequelize');

/**
 * WebhookPending — "correspondent"."webhook_pending": webhook cujo id de caso ainda não tem
 * roteamento (o provider respondeu antes de o sistema gravar o id externo). Fica guardado com a
 * assinatura original e é reprocessado quando o roteamento existir. DELIBERADAMENTE sem RLS e sem
 * company_id: ainda não se sabe a empresa; a assinatura só é conferida no reprocessamento.
 */
module.exports = (sequelize) => {
  const WebhookPending = sequelize.define(
    'WebhookPending',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      externalCaseId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_case_id' },
      externalEventId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_event_id' },
      rawBody: { type: DataTypes.TEXT, allowNull: false, field: 'raw_body' },
      signature: { type: DataTypes.TEXT, allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
      processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'webhook_pending',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
  return WebhookPending;
};
