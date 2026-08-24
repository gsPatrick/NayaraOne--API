'use strict';

const { DataTypes } = require('sequelize');

/**
 * BankTransaction — tabela "finance"."bank_transactions"
 * Transação bruta importada do extrato bancário (OFX/API), insumo da conciliação.
 */
module.exports = (sequelize) => {
  const BankTransaction = sequelize.define(
    'BankTransaction',
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
        allowNull: false,
        field: 'bank_account_id',
      },
      externalTransactionId: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
        field: 'external_transaction_id',
      },
      amount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'amount',
      },
      transactionDate: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'transaction_date',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
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
      tableName: 'bank_transactions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return BankTransaction;
};
