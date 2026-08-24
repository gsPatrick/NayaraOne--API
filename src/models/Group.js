'use strict';

const { DataTypes } = require('sequelize');

/**
 * Group — tabela "core"."groups"
 * Grupo empresarial — nível mais alto da hierarquia group -> company -> unit.
 */
module.exports = (sequelize) => {
  const Group = sequelize.define(
    'Group',
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
      legalName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'legal_name',
      },
      taxId: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'tax_id',
        comment: "CNPJ/CPF do grupo, quando aplicável",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
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
      schema: 'core',
      tableName: 'groups',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Group;
};
