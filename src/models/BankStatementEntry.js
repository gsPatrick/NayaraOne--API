'use strict';

const { DataTypes } = require('sequelize');

/**
 * BankStatementEntry — tabela "finance"."bank_statement_entries" (M9-D237). Lançamento lido do extrato do banco por cursor; UNIQUE (connection_id, entry_id).
 * `reconciliationStatus`: PENDING, RECONCILED (casou com um pagamento e o valor confere em centavos) ou MISMATCH (casou pelo id externo, valor diverge).
 */
module.exports = (sequelize) => sequelize.define(
  'BankStatementEntry',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
    entryId: { type: DataTypes.STRING(128), allowNull: false, field: 'entry_id' },
    direction: { type: DataTypes.STRING(3), allowNull: false },
    amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    bookedAt: { type: DataTypes.DATE, allowNull: false, field: 'booked_at' },
    description: { type: DataTypes.TEXT, allowNull: true },
    payeeName: { type: DataTypes.STRING(200), allowNull: true, field: 'payee_name' },
    externalPaymentId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_payment_id' },
    reconciliationStatus: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING', field: 'reconciliation_status' },
    paymentIntentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_intent_id' },
    reconciledAt: { type: DataTypes.DATE, allowNull: true, field: 'reconciled_at' },
  },
  { schema: 'finance', tableName: 'bank_statement_entries', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true },
);
