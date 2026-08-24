'use strict';

const { DataTypes } = require('sequelize');

/**
 * Visit — tabela "crm"."visits"
 * Visita agendada/realizada a um imóvel por um cliente.
 */
module.exports = (sequelize) => {
  const Visit = sequelize.define(
    'Visit',
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
      opportunityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opportunity_id',
      },
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      agentUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'agent_user_id',
      },
      scheduledAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'scheduled_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'SCHEDULED',
        field: 'status',
      },
      feedback: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'feedback',
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
      schema: 'crm',
      tableName: 'visits',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return Visit;
};
