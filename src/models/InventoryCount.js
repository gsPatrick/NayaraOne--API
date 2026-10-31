'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryCount — tabela "inventory"."counts"
 * Inventário físico por local (OPEN -> COMPLETED). Fechamento calcula divergência; nunca
 * altera saldo diretamente (EST-TS-09).
 */
module.exports = (sequelize) => {
  const InventoryCount = sequelize.define(
    'InventoryCount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      locationId: { type: DataTypes.UUID, allowNull: false, field: 'location_id' },
      projectId: { type: DataTypes.UUID, allowNull: true, field: 'project_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
      countedAt: { type: DataTypes.DATE, allowNull: true, field: 'counted_at' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'inventory',
      tableName: 'counts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return InventoryCount;
};
