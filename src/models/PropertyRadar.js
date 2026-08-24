'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyRadar — tabela "crm"."property_radars"
 * Perfil de busca (radar) de um cliente para receber imóveis compatíveis automaticamente.
 */
module.exports = (sequelize) => {
  const PropertyRadar = sequelize.define(
    'PropertyRadar',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      opportunityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'opportunity_id',
      },
      criteriaJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'criteria_json',
        comment: "Critérios de matching (tipo, bairro, faixa de preço etc.)",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
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
      tableName: 'property_radars',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return PropertyRadar;
};
