'use strict';

const { DataTypes } = require('sequelize');

/** InsuranceInstallment — tabela "procurement"."insurance_installments". */
module.exports = (sequelize) => {
  const InsuranceInstallment = sequelize.define(
    'InsuranceInstallment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
      financialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'financial_entry_id' },
      dueDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'due_date' },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_installments',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InsuranceInstallment;
};
