'use strict';

const { DataTypes } = require('sequelize');

/**
 * BillingScheduleItem — tabela "finance"."billing_schedule_items". Componente individual
 * (aluguel, condomínio, IPTU, etc.) de uma competência de cobrança.
 */
module.exports = (sequelize) => {
  const BillingScheduleItem = sequelize.define(
    'BillingScheduleItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      billingScheduleId: { type: DataTypes.UUID, allowNull: false, field: 'billing_schedule_id' },
      componentType: { type: DataTypes.STRING(32), allowNull: false, field: 'component_type' },
      description: { type: DataTypes.STRING(255), allowNull: true, field: 'description' },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'amount' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'billing_schedule_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return BillingScheduleItem;
};
