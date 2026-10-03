'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryRequisition — tabela "inventory"."requisitions"
 * Requisição de material por obra/etapa (REQUESTED -> APPROVED/REJECTED -> ISSUED).
 */
module.exports = (sequelize) => {
  const InventoryRequisition = sequelize.define(
    'InventoryRequisition',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      warehouseLocationId: { type: DataTypes.UUID, allowNull: false, field: 'warehouse_location_id' },
      projectLocationId: { type: DataTypes.UUID, allowNull: true, field: 'project_location_id' },
      projectId: { type: DataTypes.UUID, allowNull: true, field: 'project_id' },
      stageId: { type: DataTypes.UUID, allowNull: true, field: 'stage_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'REQUESTED', field: 'status' },
      requestedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'requested_by_user_id' },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'requisitions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryRequisition;
};
