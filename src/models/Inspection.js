'use strict';

const { DataTypes } = require('sequelize');

/**
 * Inspection — tabela "legal"."inspections"
 * Vistoria de um imóvel (entrada, saída, periódica) vinculada a um contrato de locação.
 */
module.exports = (sequelize) => {
  const Inspection = sequelize.define(
    'Inspection',
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
      contractId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'contract_id',
      },
      inspectorUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'inspector_user_id',
      },
      inspectionType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'inspection_type',
        comment: "CHECK_IN|CHECK_OUT|PERIODIC",
      },
      scheduledAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'scheduled_at',
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'completed_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'SCHEDULED',
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
      schema: 'legal',
      tableName: 'inspections',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Inspection;
};
