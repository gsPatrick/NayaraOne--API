'use strict';

const { DataTypes } = require('sequelize');

/**
 * InventoryLocation — tabela "inventory"."locations"
 * Depósito/almoxarifado ou canteiro de obra onde itens de estoque podem estar.
 */
module.exports = (sequelize) => {
  const InventoryLocation = sequelize.define(
    'InventoryLocation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      name: { type: DataTypes.STRING(255), allowNull: false, field: 'name' },
      locationType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'WAREHOUSE',
        field: 'location_type',
        comment: 'WAREHOUSE|PROJECT_SITE',
      },
      projectId: { type: DataTypes.UUID, allowNull: true, field: 'project_id' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'inventory',
      tableName: 'locations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return InventoryLocation;
};
