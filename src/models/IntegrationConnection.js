'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationConnection — "integration"."connections" (Marco 9, M9-D200).
 * Configuração de um fornecedor por empresa e ambiente. Guarda só a REFERÊNCIA do cofre
 * (`secretRef`), nunca o segredo.
 */
module.exports = (sequelize) => {
  const IntegrationConnection = sequelize.define(
    'IntegrationConnection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
      environment: { type: DataTypes.STRING(10), allowNull: false },
      label: { type: DataTypes.STRING(80), allowNull: false },
      status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: 'DRAFT' },
      secretRef: { type: DataTypes.STRING(160), allowNull: true, field: 'secret_ref' },
      configJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'config_json' },
      apiVersion: { type: DataTypes.STRING(16), allowNull: true, field: 'api_version' },
      webhookChannel: { type: DataTypes.STRING(48), allowNull: true, field: 'webhook_channel' },
      policyJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'policy_json' },
      productionReleasedAt: { type: DataTypes.DATE, allowNull: true, field: 'production_released_at' },
      productionReleasedBy: { type: DataTypes.UUID, allowNull: true, field: 'production_released_by' },
      lastSecretRotationAt: { type: DataTypes.DATE, allowNull: true, field: 'last_secret_rotation_at' },
      secretExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'secret_expires_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'integration',
      tableName: 'connections',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return IntegrationConnection;
};
