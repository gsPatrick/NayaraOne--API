'use strict';

const { DataTypes } = require('sequelize');

/**
 * Budget — tabela "construction"."budgets"
 * Orçamento agregado da obra. Máquina de estados DRAFT->APPROVED; depois de `APPROVED`,
 * `baselineAmount`/`ruleVersionId` ficam congelados e só mudam via Change Order aprovado
 * (ver src/features/construction/budgets.service.js e changeOrders.service.js).
 */
module.exports = (sequelize) => {
  const Budget = sequelize.define(
    'Budget',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectId: { type: DataTypes.UUID, allowNull: false, field: 'project_id' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'total_amount' },
      baselineAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'baseline_amount' },
      ruleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'rule_version_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      approvedBy: { type: DataTypes.UUID, allowNull: true, field: 'approved_by' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'budgets',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Budget;
};
