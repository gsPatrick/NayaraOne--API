'use strict';

const { DataTypes } = require('sequelize');

/**
 * FinancingProposal — tabela "correspondent"."proposals" (Marco 8): as condições que o banco devolve
 * para o caso (valor aprovado, taxa, prazo, parcela e validade). Só uma proposta fica ACTIVE por
 * caso; ao registrar outra, a anterior vira SUPERSEDED (nunca é apagada).
 */
module.exports = (sequelize) => {
  const FinancingProposal = sequelize.define(
    'FinancingProposal',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      source: { type: DataTypes.STRING(16), allowNull: false },
      approvedAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'approved_amount' },
      annualRatePct: { type: DataTypes.DECIMAL(7, 4), allowNull: true, field: 'annual_rate_pct' },
      termMonths: { type: DataTypes.INTEGER, allowNull: false, field: 'term_months' },
      monthlyPayment: { type: DataTypes.DECIMAL(14, 2), allowNull: true, field: 'monthly_payment' },
      validUntil: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_until' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'ACTIVE' },
      responseSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'response_snapshot' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { schema: 'correspondent', tableName: 'proposals', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );
  return FinancingProposal;
};
