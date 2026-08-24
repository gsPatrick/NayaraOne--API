'use strict';

const { DataTypes } = require('sequelize');

/**
 * Asset — tabela "inventory"."assets"
 * Bem patrimonial (ferramenta, equipamento, veículo) rastreável por QR Code.
 */
module.exports = (sequelize) => {
  const Asset = sequelize.define(
    'Asset',
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
      assetTag: {
        type: DataTypes.STRING(64),
        allowNull: true,
        unique: true,
        field: 'asset_tag',
        comment: "Código impresso no QR Code",
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      assignedToUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'assigned_to_user_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'project_id',
      },
      acquisitionValue: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'acquisition_value',
      },
      acquiredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'acquired_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'IN_USE',
        field: 'status',
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
      schema: 'inventory',
      tableName: 'assets',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Asset;
};
