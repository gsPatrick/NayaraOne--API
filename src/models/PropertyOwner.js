'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyOwner — tabela "real_estate"."property_owners"
 * Vínculo de titularidade/proprietário (ou usufrutuário) de um imóvel, com percentual de
 * participação. PK própria (uuid) mantida — o Caderno Técnico não lista PK explícita para esta
 * tabela, apenas o índice (property_id, valid_until).
 */
module.exports = (sequelize) => {
  const PropertyOwner = sequelize.define(
    'PropertyOwner',
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
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
      },
      ownershipPercent: {
        type: DataTypes.DECIMAL(7, 4),
        allowNull: true,
        field: 'ownership_percent',
      },
      roleCode: {
        type: DataTypes.STRING(30),
        allowNull: false,
        field: 'role_code',
        comment: 'OWNER|USUFRUCTUARY (mínimo confirmado pelo Caderno)',
      },
      validFrom: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'valid_from',
      },
      validUntil: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'valid_until',
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
      schema: 'real_estate',
      tableName: 'property_owners',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return PropertyOwner;
};
