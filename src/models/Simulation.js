'use strict';

const { DataTypes } = require('sequelize');

/**
 * Simulation — tabela "correspondent"."simulations" (Marco 8 Fase 3). Cada simulação é uma
 * linha nova, nunca atualizada ("múltiplas simulações ficam versionadas" — Caderno Técnico).
 */
module.exports = (sequelize) => {
  const Simulation = sequelize.define(
    'Simulation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      termMonths: { type: DataTypes.INTEGER, allowNull: false, field: 'term_months' },
      monthlyPayment: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'monthly_payment' },
      rate: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      requestSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'request_snapshot' },
      responseSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'response_snapshot' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'simulations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return Simulation;
};
