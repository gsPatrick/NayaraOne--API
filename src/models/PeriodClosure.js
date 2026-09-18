'use strict';

const { DataTypes } = require('sequelize');

/**
 * PeriodClosure — tabela "finance"."period_closures"
 * Fechamento mensal de competência por empresa. Um registro por (companyId, referenceMonth).
 */
module.exports = (sequelize) => {
  const PeriodClosure = sequelize.define(
    'PeriodClosure',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      referenceMonth: {
        type: DataTypes.STRING(7),
        allowNull: false,
        field: 'reference_month',
        comment: 'YYYY-MM',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
        comment: 'OPEN|CLOSED',
      },
      closedAt: { type: DataTypes.DATE, allowNull: true, field: 'closed_at' },
      closedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'closed_by_user_id' },
      reopenedAt: { type: DataTypes.DATE, allowNull: true, field: 'reopened_at' },
      reopenedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reopened_by_user_id' },
      reopenReason: { type: DataTypes.TEXT, allowNull: true, field: 'reopen_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'period_closures',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PeriodClosure;
};
