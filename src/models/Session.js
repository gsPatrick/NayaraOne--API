'use strict';

const { DataTypes } = require('sequelize');

/**
 * Session — tabela "core"."sessions"
 * Sessão de autenticação (refresh token) de um usuário em um tenant (group/company) ativo.
 * Um usuário pode ter múltiplas sessões concorrentes (multi-dispositivo); cada sessão fixa
 * o group_id/company_id ativos no momento do login (troca de tenant = novo login).
 */
module.exports = (sequelize) => {
  const Session = sequelize.define(
    'Session',
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
      refreshTokenHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
        field: 'refresh_token_hash',
      },
      userAgent: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'user_agent',
      },
      ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'ip_address',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'revoked_at',
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
      tableName: 'sessions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Session;
};
