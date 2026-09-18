'use strict';

const { DataTypes } = require('sequelize');

/**
 * ChartOfAccount — tabela "finance"."chart_of_accounts"
 * Plano de contas contábil, hierárquico (parent_account_id). Não confundir com CostCenter/
 * ResultCenter, que são dimensões gerenciais de rateio. Desativação é lógica (is_active) —
 * conta com lançamento vinculado nunca é apagada.
 */
module.exports = (sequelize) => {
  const ChartOfAccount = sequelize.define(
    'ChartOfAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(32), allowNull: false, field: 'code' },
      name: { type: DataTypes.STRING(255), allowNull: false, field: 'name' },
      accountType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'account_type',
        comment: 'ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE',
      },
      parentAccountId: { type: DataTypes.UUID, allowNull: true, field: 'parent_account_id' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'chart_of_accounts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ChartOfAccount;
};
