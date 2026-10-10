'use strict';

const { DataTypes } = require('sequelize');

/**
 * InsurancePolicy — tabela "procurement"."insurance_policies" (Insurance Hub, Marco 7).
 */
module.exports = (sequelize) => {
  const InsurancePolicy = sequelize.define(
    'InsurancePolicy',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      propertyId: { type: DataTypes.UUID, allowNull: true, field: 'property_id' },
      contractId: { type: DataTypes.UUID, allowNull: true, field: 'contract_id' },
      provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'sandbox' },
      externalPolicyNumber: { type: DataTypes.STRING(128), allowNull: true, field: 'external_policy_number' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT' },
      coverageSummary: { type: DataTypes.TEXT, allowNull: true, field: 'coverage_summary' },
      premiumAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'premium_amount' },
      effectiveDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'effective_date' },
      expiryDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'expiry_date' },
      quoteSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'quote_snapshot' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_policies',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InsurancePolicy;
};
