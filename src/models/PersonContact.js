'use strict';

const { DataTypes } = require('sequelize');

/**
 * PersonContact — tabela "people"."person_contacts" (TAB-0102)
 * Canal de contato de uma pessoa. contact_type é enum FECHADO: PHONE, WHATSAPP, EMAIL.
 */
module.exports = (sequelize) => {
  const PersonContact = sequelize.define(
    'PersonContact',
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
      contactType: {
        type: DataTypes.STRING(30),
        allowNull: false,
        field: 'contact_type',
        comment: 'PHONE|WHATSAPP|EMAIL',
      },
      valueNormalized: {
        type: DataTypes.STRING(254),
        allowNull: false,
        field: 'value_normalized',
      },
      isPrimary: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_primary',
      },
      consentStatus: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'consent_status',
      },
      verifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'verified_at',
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
      schema: 'people',
      tableName: 'person_contacts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return PersonContact;
};
