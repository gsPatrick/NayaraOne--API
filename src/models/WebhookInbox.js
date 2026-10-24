'use strict';

const { DataTypes } = require('sequelize');

/**
 * WebhookInbox — tabela "correspondent"."webhook_inbox" (Marco 8 Fase 6). Dedup de webhook por
 * `UNIQUE(provider_code, external_event_id)` (ver migration) — um evento já recebido nunca
 * reaplica o status.
 */
module.exports = (sequelize) => {
  const WebhookInbox = sequelize.define(
    'WebhookInbox',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      externalEventId: { type: DataTypes.STRING(160), allowNull: false, field: 'external_event_id' },
      payload: { type: DataTypes.JSONB, allowNull: false },
      receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'webhook_inbox',
      timestamps: false,
      underscored: true,
    }
  );
  return WebhookInbox;
};
