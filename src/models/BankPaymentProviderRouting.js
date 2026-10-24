'use strict';

const { DataTypes } = require('sequelize');

/**
 * BankPaymentProviderRouting — tabela "finance"."bank_payment_provider_routing".
 * SEM RLS (mesmo padrão de SignatureProviderRouting) — só ids opacos de roteamento, nunca
 * dado de negócio. Webhook público do banco chega sem JWT/tenant conhecido de antemão; esta
 * tabela é a única consultável sem contexto de tenant pra resolver group_id/company_id antes
 * de aplicar RLS no resto do fluxo.
 */
module.exports = (sequelize) => {
  const BankPaymentProviderRouting = sequelize.define(
    'BankPaymentProviderRouting',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      externalSubmissionId: { type: DataTypes.STRING, allowNull: false, field: 'external_submission_id' },
      paymentIntentId: { type: DataTypes.UUID, allowNull: false, field: 'payment_intent_id' },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    },
    {
      schema: 'finance',
      tableName: 'bank_payment_provider_routing',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return BankPaymentProviderRouting;
};
