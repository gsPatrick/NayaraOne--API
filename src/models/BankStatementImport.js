'use strict';

const { DataTypes } = require('sequelize');

/**
 * BankStatementImport — tabela "finance"."bank_statement_imports" (F02, 2ª rodada). Registro de
 * cada importação de extrato: conta, período coberto (declarado por quem importou ou deduzido
 * das datas das linhas) e saldo final informado. É o que a pré-condição "extratos importados"
 * do fechamento confere: o mês inteiro precisa estar coberto por importação. Append-only.
 */
module.exports = (sequelize) => {
  const BankStatementImport = sequelize.define(
    'BankStatementImport',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      bankAccountId: { type: DataTypes.UUID, allowNull: false, field: 'bank_account_id' },
      periodStart: { type: DataTypes.DATEONLY, allowNull: false, field: 'period_start' },
      periodEnd: { type: DataTypes.DATEONLY, allowNull: false, field: 'period_end' },
      periodDeclared: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'period_declared' },
      closingBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'closing_balance' },
      linesTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lines_total' },
      linesImported: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lines_imported' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'finance',
      tableName: 'bank_statement_imports',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return BankStatementImport;
};
