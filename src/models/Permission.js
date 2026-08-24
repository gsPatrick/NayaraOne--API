'use strict';

const { DataTypes } = require('sequelize');

/**
 * Permission — tabela "core"."permissions"
 * Permissão granular (catálogo global) referenciável por roles — ex. finance.entries.approve.
 */
module.exports = (sequelize) => {
  const Permission = sequelize.define(
    'Permission',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      code: {
        type: DataTypes.STRING(128),
        allowNull: false,
        unique: true,
        field: 'code',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
      },
      riskLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'LOW',
        field: 'risk_level',
        comment: "LOW|MEDIUM|HIGH|CRITICAL",
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
      tableName: 'permissions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Permission;
};
