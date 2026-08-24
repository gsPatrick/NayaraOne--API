'use strict';

const { DataTypes } = require('sequelize');

/**
 * CostCenter — tabela "finance"."cost_centers"
 * Centro de custo para classificação de lançamentos financeiros.
 */
module.exports = (sequelize) => {
  const CostCenter = sequelize.define(
    'CostCenter',
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
      code: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'code',
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
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
      schema: 'finance',
      tableName: 'cost_centers',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return CostCenter;
};
