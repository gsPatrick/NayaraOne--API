'use strict';

const { DataTypes } = require('sequelize');

/**
 * BillingSchedule — tabela "finance"."billing_schedules". Cronograma de cobrança de locação,
 * uma linha por competência (period) por contrato — UNIQUE (contract_id, period).
 */
module.exports = (sequelize) => {
  const BillingSchedule = sequelize.define(
    'BillingSchedule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      period: { type: DataTypes.STRING(7), allowNull: false, field: 'period' },
      dueDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'due_date' },
      totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'total_amount' },
      paidAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'paid_amount' },
      balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'balance' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      generatedAt: { type: DataTypes.DATE, allowNull: false, field: 'generated_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'billing_schedules',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return BillingSchedule;
};
