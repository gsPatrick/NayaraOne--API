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
      description: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'description',
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'due_at',
      },
      competenceMonth: {
        type: DataTypes.STRING(7),
        allowNull: true,
        field: 'competence_month',
        comment: 'Mês contábil de competência no formato "YYYY-MM" (pode diferir do mês de vencimento)',
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
      parentEntryId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'parent_entry_id',
        comment: 'Auto-referência: preenchido nas baixas PARCIAIS, aponta para o lançamento original',
      },
      requiresManualReview: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'requires_manual_review',
        comment: 'Antifraude: pagamento anômalo, travado até revisão humana',
      },
      manualReviewReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'manual_review_reason',
      },
      manualReviewClearedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'manual_review_cleared_at',
      },
      manualReviewClearedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'manual_review_cleared_by',
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
