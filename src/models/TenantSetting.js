'use strict';

const { DataTypes } = require('sequelize');

/**
 * TenantSetting — tabela "core"."tenant_settings". Painel admin de configuração por tenant
 * (chave/valor JSONB), UNIQUE(company_id, key). Ver src/features/settings/settings.service.js.
 */
module.exports = (sequelize) => {
  const TenantSetting = sequelize.define(
    'TenantSetting',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      key: { type: DataTypes.STRING(128), allowNull: false, field: 'key' },
      value: { type: DataTypes.JSONB, allowNull: false, field: 'value' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'core',
      tableName: 'tenant_settings',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return TenantSetting;
};
