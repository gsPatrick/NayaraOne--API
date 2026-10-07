'use strict';

const { DataTypes } = require('sequelize');

/** InsuranceClaim — tabela "procurement"."insurance_claims". */
module.exports = (sequelize) => {
  const InsuranceClaim = sequelize.define(
    'InsuranceClaim',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
      financialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'financial_entry_id' },
      externalClaimId: { type: DataTypes.STRING(128), allowNull: true, field: 'external_claim_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN' },
      description: { type: DataTypes.TEXT, allowNull: true },
      claimAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'claim_amount' },
      settledAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'settled_amount' },
      openedAt: { type: DataTypes.DATE, allowNull: false, field: 'opened_at' },
      settledAt: { type: DataTypes.DATE, allowNull: true, field: 'settled_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_claims',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InsuranceClaim;
};
