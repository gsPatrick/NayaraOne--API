'use strict';

const { DataTypes } = require('sequelize');

/**
 * BudgetRevision — tabela "construction"."budget_revisions" (migration 20260101006602), append-only (gatilho recusa
 * UPDATE e DELETE). Cada Change Order aprovado vira uma revisão nova com o total anterior, o impacto e o total novo;
 * a baseline aprovada (construction.budgets.baseline_amount) nunca sofre UPDATE (Guia do Marcelo §3).
 */
module.exports = (sequelize) =>
  sequelize.define(
    'BudgetRevision',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      budgetId: { type: DataTypes.UUID, allowNull: false, field: 'budget_id' },
      projectId: { type: DataTypes.UUID, allowNull: false, field: 'project_id' },
      revisionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'revision_number' },
      changeOrderId: { type: DataTypes.UUID, allowNull: true, field: 'change_order_id' },
      previousTotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'previous_total' },
      budgetImpact: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'budget_impact' },
      newTotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'new_total' },
      reason: { type: DataTypes.TEXT, allowNull: true, field: 'reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'construction',
      tableName: 'budget_revisions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );
