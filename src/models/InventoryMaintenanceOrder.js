'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryMaintenanceOrder — tabela "inventory"."maintenance_orders"
 * OS de manutenção de um Asset (OPEN -> CLOSED), podendo nascer de uma devolução de ferramenta
 * danificada (sourceToolLoanId).
 */
module.exports = (sequelize) => {
  const InventoryMaintenanceOrder = sequelize.define(
    'InventoryMaintenanceOrder',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      assetId: { type: DataTypes.UUID, allowNull: false, field: 'asset_id' },
      sourceToolLoanId: { type: DataTypes.UUID, allowNull: true, field: 'source_tool_loan_id' },
      description: { type: DataTypes.TEXT, allowNull: true, field: 'description' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      openedAt: { type: DataTypes.DATE, allowNull: false, field: 'opened_at' },
      closedAt: { type: DataTypes.DATE, allowNull: true, field: 'closed_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'maintenance_orders',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return InventoryMaintenanceOrder;
};
