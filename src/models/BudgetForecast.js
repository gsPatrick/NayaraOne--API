'use strict';

const { DataTypes } = require('sequelize');

/**
 * BudgetForecast — tabela "finance"."budgets_forecasts"
 * Orçamento/projeção financeira (Caderno §5, "Entidades/tabelas obrigatórias") — uma linha por
 * grupo/empresa/mês-competência/centro, com o valor projetado. O realizado é comparado em
 * tempo de leitura contra finance.financial_entries (ver budgetsForecasts.service.js), nunca
 * duplicado aqui.
 */
module.exports = (sequelize) => {
  const BudgetForecast = sequelize.define(
    'BudgetForecast',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      competenceMonth: { type: DataTypes.STRING(7), allowNull: false, field: 'competence_month' },
      nature: { type: DataTypes.STRING(16), allowNull: false, field: 'nature', comment: 'PAYABLE|RECEIVABLE' },
      costCenterId: { type: DataTypes.UUID, allowNull: true, field: 'cost_center_id' },
      resultCenterId: { type: DataTypes.UUID, allowNull: true, field: 'result_center_id' },
      description: { type: DataTypes.STRING(255), allowNull: true, field: 'description' },
      forecastedAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'forecasted_amount' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'budgets_forecasts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return BudgetForecast;
};
