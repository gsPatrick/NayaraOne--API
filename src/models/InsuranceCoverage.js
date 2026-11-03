'use strict';

const { DataTypes } = require('sequelize');

/** InsuranceCoverage — tabela "procurement"."insurance_coverages". */
module.exports = (sequelize) => {
  const InsuranceCoverage = sequelize.define(
    'InsuranceCoverage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
      coverageType: { type: DataTypes.STRING(64), allowNull: false, field: 'coverage_type' },
      limitAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'limit_amount' },
      description: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_coverages',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return InsuranceCoverage;
};
