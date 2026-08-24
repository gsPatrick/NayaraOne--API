'use strict';

const { DataTypes } = require('sequelize');

/**
 * Project — tabela "construction"."projects"
 * Obra/empreendimento de construção civil.
 */
module.exports = (sequelize) => {
  const Project = sequelize.define(
    'Project',
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
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      budgetAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'budget_amount',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAtPlanned: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at_planned',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PLANNED',
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
      schema: 'construction',
      tableName: 'projects',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Project;
};
