'use strict';

const { DataTypes } = require('sequelize');

/**
 * RolePermission — tabela "core"."role_permissions"
 * Associação N:N entre roles e permissions.
 */
module.exports = (sequelize) => {
  const RolePermission = sequelize.define(
    'RolePermission',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      roleId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'role_id',
      },
      permissionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'permission_id',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'core',
      tableName: 'role_permissions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RolePermission;
};
