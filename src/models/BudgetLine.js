'use strict';

const { DataTypes } = require('sequelize');

/**
 * BudgetLine — tabela "construction"."budget_lines"
 * Linha de orçamento/custo de uma obra (previsto x realizado).
 */
module.exports = (sequelize) => {
  const BudgetLine = sequelize.define(
    'BudgetLine',
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
      costCenterId: { type: DataTypes.UUID, allowNull: true, field: 'cost_center_id' },
      category: { type: DataTypes.STRING(128), allowNull: false, field: 'category' },
      description: { type: DataTypes.STRING(255), allowNull: true, field: 'description' },
      plannedAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'planned_amount' },
      actualAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'actual_amount' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'budget_lines',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return BudgetLine;
};
