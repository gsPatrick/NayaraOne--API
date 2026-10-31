'use strict';

const { DataTypes } = require('sequelize');

/**
 * CommissionAdjustment — tabela "correspondent"."commission_adjustments" (Marco 8): o ajuste
 * (estorno/chargeback) de um direito de comissão. Append-only; o direito original não perde o valor.
 */
module.exports = (sequelize) => {
  const CommissionAdjustment = sequelize.define(
    'CommissionAdjustment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      commissionEntitlementId: { type: DataTypes.UUID, allowNull: false, field: 'commission_entitlement_id' },
      adjustmentType: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'CHARGEBACK', field: 'adjustment_type' },
      statusBefore: { type: DataTypes.STRING(16), allowNull: false, field: 'status_before' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: false },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { schema: 'correspondent', tableName: 'commission_adjustments', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
  );
  return CommissionAdjustment;
};
