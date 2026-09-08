'use strict';

const { DataTypes } = require('sequelize');

/**
 * RentAdjustment — tabela "finance"."rent_adjustments". Reajuste de aluguel por índice.
 * status default PENDING_SOURCE — nunca grava percentual inventado quando o índice não está
 * disponível (ver rentAdjustment.service.js e adapters/IndexSourceAdapter.js).
 */
module.exports = (sequelize) => {
  const RentAdjustment = sequelize.define(
    'RentAdjustment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      indexCode: { type: DataTypes.STRING(32), allowNull: false, field: 'index_code' },
      period: { type: DataTypes.STRING(7), allowNull: false, field: 'period' },
      rawIndexValue: { type: DataTypes.DECIMAL(12, 6), allowNull: true, field: 'raw_index_value' },
      appliedPercentage: { type: DataTypes.DECIMAL(12, 6), allowNull: true, field: 'applied_percentage' },
      oldRentAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'old_rent_amount' },
      newRentAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'new_rent_amount' },
      ruleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'rule_version_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING_SOURCE', field: 'status' },
      appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'rent_adjustments',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return RentAdjustment;
};
