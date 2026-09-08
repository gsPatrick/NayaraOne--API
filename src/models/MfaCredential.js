'use strict';

const { DataTypes } = require('sequelize');

/**
 * MfaCredential — tabela "core"."mfa_credentials". Segredo TOTP por usuário (RFC 6238) +
 * códigos de recuperação de uso único. Ver migrations/20260101000102-create-core-mfa_credentials.js
 * para as decisões de engenharia (RLS, secret cifrado via src/utils/mfaCrypto.js).
 */
module.exports = (sequelize) => {
  const MfaCredential = sequelize.define(
    'MfaCredential',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        field: 'user_id',
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
      secretEncrypted: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'secret_encrypted',
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      confirmedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'confirmed_at',
      },
      recoveryCodesHash: {
        type: DataTypes.ARRAY(DataTypes.TEXT),
        allowNull: false,
        defaultValue: [],
        field: 'recovery_codes_hash',
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
      tableName: 'mfa_credentials',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MfaCredential;
};
