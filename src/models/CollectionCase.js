'use strict';

const { DataTypes } = require('sequelize');

/**
 * CollectionCase — tabela "finance"."collection_cases". Caso de cobrança aberto quando uma
 * competência fica em atraso. `agreements_json` é histórico append-only de acordos de
 * cobrança (ver migration 20260101000104 para a justificativa da decisão).
 */
module.exports = (sequelize) => {
  const CollectionCase = sequelize.define(
    'CollectionCase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      billingScheduleId: { type: DataTypes.UUID, allowNull: false, field: 'billing_schedule_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      overdueSince: { type: DataTypes.DATEONLY, allowNull: false, field: 'overdue_since' },
      originalDebtAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'original_debt_amount' },
      currentBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'current_balance' },
      penaltyAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'penalty_amount' },
      interestAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'interest_amount' },
      graceDaysApplied: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'grace_days_applied' },
      penaltyRuleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'penalty_rule_version_id' },
      graceRuleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'grace_rule_version_id' },
      agreementsJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'agreements_json' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'collection_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return CollectionCase;
};
