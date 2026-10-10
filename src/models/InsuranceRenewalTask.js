'use strict';

const { DataTypes } = require('sequelize');

/** InsuranceRenewalTask — tabela "procurement"."insurance_renewal_tasks" (alerta de renovação). */
module.exports = (sequelize) => {
  const InsuranceRenewalTask = sequelize.define(
    'InsuranceRenewalTask',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
      dueDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'due_date' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: 'assigned_to_user_id' },
      // Marcador de idempotência de insuranceRenewalAlertJob.js — alerta uma vez só.
      lastAlertedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_alerted_at' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_renewal_tasks',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InsuranceRenewalTask;
};
