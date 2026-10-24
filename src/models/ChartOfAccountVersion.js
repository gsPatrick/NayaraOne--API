'use strict';

const { DataTypes } = require('sequelize');

/**
 * ChartOfAccountVersion — tabela "finance"."chart_of_account_versions" (append-only por trigger).
 * Cada alteração de uma conta do plano de contas fecha a vigência da versão aberta e abre uma
 * nova (§4: "Plano de contas versionado" / "classificação vigente no fato").
 */
module.exports = (sequelize) => {
  const ChartOfAccountVersion = sequelize.define(
    'ChartOfAccountVersion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      chartOfAccountId: { type: DataTypes.UUID, allowNull: false, field: 'chart_of_account_id' },
      versionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'version_number' },
      code: { type: DataTypes.STRING(32), allowNull: false, field: 'code' },
      name: { type: DataTypes.STRING(255), allowNull: false, field: 'name' },
      accountType: { type: DataTypes.STRING(16), allowNull: false, field: 'account_type' },
      parentAccountId: { type: DataTypes.UUID, allowNull: true, field: 'parent_account_id' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, field: 'is_active' },
      changeReason: { type: DataTypes.TEXT, allowNull: true, field: 'change_reason' },
      effectiveFrom: { type: DataTypes.DATE, allowNull: false, field: 'effective_from' },
      effectiveUntil: { type: DataTypes.DATE, allowNull: true, field: 'effective_until' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'finance',
      tableName: 'chart_of_account_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return ChartOfAccountVersion;
};
