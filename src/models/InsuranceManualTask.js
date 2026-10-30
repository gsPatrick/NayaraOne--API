'use strict';

const { DataTypes } = require('sequelize');

/**
 * InsuranceManualTask — tabela "procurement"."insurance_manual_tasks" (M9-D238): a tarefa que o fluxo manual da seguradora sem API entrega a uma pessoa
 * (anexar a cotação recebida, registrar o número da proposta, anexar a apólice). Concluí-la produz o mesmo evento interno que a API produziria.
 */
module.exports = (sequelize) => sequelize.define(
  'InsuranceManualTask',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
    dispatchId: { type: DataTypes.UUID, allowNull: true, field: 'dispatch_id' },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    purpose: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'NEW' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'OPEN' },
    assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: 'assigned_to_user_id' },
    dueAt: { type: DataTypes.DATE, allowNull: true, field: 'due_at' },
    requestJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'request_json' },
    resultJson: { type: DataTypes.JSONB, allowNull: true, field: 'result_json' },
    fileId: { type: DataTypes.UUID, allowNull: true, field: 'file_id' },
    completedBy: { type: DataTypes.UUID, allowNull: true, field: 'completed_by' },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
  },
  { schema: 'procurement', tableName: 'insurance_manual_tasks', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
