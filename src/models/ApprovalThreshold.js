'use strict';

const { DataTypes } = require('sequelize');

/**
 * ApprovalThreshold — tabela "construction"."approval_thresholds"
 * Limite de valor (alçada) configurável por empresa/contexto, acima do qual um registro exige
 * aprovação explícita em vez de autoaprovação (hoje usado só por loss_records — M6-29).
 */
module.exports = (sequelize) => {
  const ApprovalThreshold = sequelize.define(
    'ApprovalThreshold',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      context: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'MATERIAL_LOSS', field: 'context' },
      maxAutoApproveAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 1000.0, field: 'max_auto_approve_amount' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'construction',
      tableName: 'approval_thresholds',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ApprovalThreshold;
};
