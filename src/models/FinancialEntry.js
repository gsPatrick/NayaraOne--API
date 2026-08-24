'use strict';

const { DataTypes } = require('sequelize');

/**
 * FinancialEntry — tabela "finance"."financial_entries"
 * Ledger financeiro append-only — lançamento realizado (correção sempre por estorno/compensação, nunca UPDATE/DELETE destrutivo).
 */
module.exports = (sequelize) => {
  const FinancialEntry = sequelize.define(
    'FinancialEntry',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      bankAccountId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'bank_account_id',
      },
      costCenterId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'cost_center_id',
      },
      resultCenterId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'result_center_id',
      },
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      entryType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'entry_type',
        comment: "DEBIT|CREDIT",
      },
      nature: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'nature',
        comment: "PAYABLE|RECEIVABLE|TRANSFER|ADJUSTMENT",
      },
      amount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'amount',
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'due_at',
      },
      settledAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'settled_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      idempotencyKey: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
        field: 'idempotency_key',
      },
      reversalOfEntryId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'reversal_of_entry_id',
        comment: "Auto-referência: aponta para o lançamento estornado",
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'finance',
      tableName: 'financial_entries',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return FinancialEntry;
};
