'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationProvider — "integration"."providers" (Marco 9, M9-D200).
 * Catálogo global de fornecedores lógicos (não pertence a nenhuma empresa).
 */
module.exports = (sequelize) => {
  const IntegrationProvider = sequelize.define(
    'IntegrationProvider',
    {
      code: { type: DataTypes.STRING(48), primaryKey: true, allowNull: false },
      displayName: { type: DataTypes.STRING(120), allowNull: false, field: 'display_name' },
      domain: { type: DataTypes.STRING(24), allowNull: false },
      capabilities: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      supportedVersions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'supported_versions' },
      criticality: { type: DataTypes.STRING(10), allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ACTIVE' },
      defaultPolicyJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'default_policy_json' },
      configSchema: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'config_schema' },
      sandboxAvailable: { type: DataTypes.BOOLEAN, allowNull: false, field: 'sandbox_available' },
    },
    {
      schema: 'integration',
      tableName: 'providers',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return IntegrationProvider;
};
