'use strict';

const { DataTypes } = require('sequelize');

/**
 * UserMembership — tabela "core"."user_memberships"
 * Vínculo de um usuário a uma empresa/unidade, com papel(is) associados.
 */
module.exports = (sequelize) => {
  const UserMembership = sequelize.define(
    'UserMembership',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      unitId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'unit_id',
      },
      roleId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'role_id',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
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
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'core',
      tableName: 'user_memberships',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return UserMembership;
};
