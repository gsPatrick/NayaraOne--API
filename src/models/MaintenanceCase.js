'use strict';

const { DataTypes } = require('sequelize');

/**
 * MaintenanceCase — tabela "construction"."maintenance_cases"
 * Chamado de manutenção/pós-obra vinculado a um imóvel/projeto, dentro do prazo de garantia.
 */
module.exports = (sequelize) => {
  const MaintenanceCase = sequelize.define(
    'MaintenanceCase',
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
        allowNull: false,
        field: 'property_id',
      },
      projectId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'project_id',
      },
      openedByPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opened_by_person_id',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'description',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      warrantyDeadlineAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'warranty_deadline_at',
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
      tableName: 'maintenance_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return MaintenanceCase;
};
