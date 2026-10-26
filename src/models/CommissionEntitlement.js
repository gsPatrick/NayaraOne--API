'use strict';

const { DataTypes } = require('sequelize');

/**
 * CommissionEntitlement — tabela "correspondent"."commission_entitlements" (Marco 8 Fase 8).
 * Ciclo EXPECTED → CONFIRMED → RECEIVABLE → RECEIVED → ADJUSTED.
 * O estorno não apaga o fato original — mesmo padrão de Commission.cancelCommission
 * (src/features/finance/commissions.service.js).
 */
module.exports = (sequelize) => {
  const CommissionEntitlement = sequelize.define(
    'CommissionEntitlement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'EXPECTED' },
      baseAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'base_amount' },
      percentage: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      triggerEvent: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'REGISTRO_MANUAL', field: 'trigger_event' },
      brokerSharePct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 100, field: 'broker_share_pct' },
      managerSharePct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0, field: 'manager_share_pct' },
      brokerAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'broker_amount' },
      managerAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'manager_amount' },
      ruleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'rule_version_id' },
      externalConfirmationId: { type: DataTypes.STRING(128), allowNull: true, field: 'external_confirmation_id' },
      confirmedAt: { type: DataTypes.DATE, allowNull: true, field: 'confirmed_at' },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      financialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'financial_entry_id' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'commission_entitlements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return CommissionEntitlement;
};
