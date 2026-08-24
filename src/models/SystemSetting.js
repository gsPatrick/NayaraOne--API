'use strict';

const { DataTypes } = require('sequelize');

/**
 * SystemSetting — tabela "core"."system_settings"
 * Configuração versionada por empresa (evita hard-code de valores de negócio na interface/código).
 */
module.exports = (sequelize) => {
  const SystemSetting = sequelize.define(
    'SystemSetting',
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
      key: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'key',
      },
      valueJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'value_json',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
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
    },
    {
      schema: 'core',
      tableName: 'system_settings',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return SystemSetting;
};
