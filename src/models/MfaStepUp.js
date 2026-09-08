'use strict';

const { DataTypes } = require('sequelize');

/**
 * MfaStepUp — tabela "core"."mfa_step_ups". Janela de "MFA recente" (uma linha por usuário,
 * upsert a cada `verify` bem-sucedido). Ver migrations/20260101000103-create-core-mfa_step_ups.js
 * para a decisão de engenharia por trás do desenho (tabela dedicada em vez de sessionId no JWT).
 */
module.exports = (sequelize) => {
  const MfaStepUp = sequelize.define(
    'MfaStepUp',
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
      verifiedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'verified_at',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
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
      tableName: 'mfa_step_ups',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return MfaStepUp;
};
