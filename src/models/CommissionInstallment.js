'use strict';

const { DataTypes } = require('sequelize');

/**
 * CommissionInstallment — tabela "finance"."commission_installments"
 * Parcela de pagamento de uma comissão.
 */
module.exports = (sequelize) => {
  const CommissionInstallment = sequelize.define(
    'CommissionInstallment',
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
      commissionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'commission_id',
      },
      installmentNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'installment_number',
      },
      amount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'amount',
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'due_at',
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'paid_at',
      },
      financialEntryId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'financial_entry_id',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
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
      tableName: 'commission_installments',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return CommissionInstallment;
};
