'use strict';

const { DataTypes } = require('sequelize');

/**
 * InvoiceEvent — tabela "correspondent"."invoice_events" (Marco 8 Fase 12). Histórico append-only
 * de mudanças de status de uma NFS-e (nunca UPDATE, só INSERT) — mesmo espírito de
 * ProviderStatusHistory (Fase 6), guarda status bruto E normalizado, nunca perde o evento.
 */
module.exports = (sequelize) => {
  const InvoiceEvent = sequelize.define(
    'InvoiceEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      invoiceRequestId: { type: DataTypes.UUID, allowNull: false, field: 'invoice_request_id' },
      rawStatus: { type: DataTypes.STRING(32), allowNull: false, field: 'raw_status' },
      normalizedStatus: { type: DataTypes.STRING(16), allowNull: true, field: 'normalized_status' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
    },
    {
      schema: 'correspondent',
      tableName: 'invoice_events',
      timestamps: false,
      underscored: true,
    }
  );
  return InvoiceEvent;
};
