'use strict';

const { DataTypes } = require('sequelize');

/**
 * User — tabela "core"."users"
 * Usuário autenticável do sistema (identidade).
 */
module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
        field: 'email',
      },
      passwordHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'password_hash',
      },
      mfaEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'mfa_enabled',
      },
      mfaMethod: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'mfa_method',
        comment: "TOTP | WEBAUTHN | PASSKEY — nunca SMS como preferencial",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_login_at',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
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
      tableName: 'users',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return User;
};
