'use strict';

const { DataTypes } = require('sequelize');

/**
 * PersonAddress — tabela "people"."person_addresses"
 * Endereços versionados de uma pessoa (nome confirmado pelo Caderno; colunas são inferência —
 * ver comentário na migration 20260101000087-create-people-person_addresses.js).
 */
module.exports = (sequelize) => {
  const PersonAddress = sequelize.define(
    'PersonAddress',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      zipCode: { type: DataTypes.STRING(9), allowNull: true, field: 'zip_code' },
      street: { type: DataTypes.STRING(200), allowNull: true, field: 'street' },
      number: { type: DataTypes.STRING(20), allowNull: true, field: 'number' },
      complement: { type: DataTypes.STRING(100), allowNull: true, field: 'complement' },
      neighborhood: { type: DataTypes.STRING(100), allowNull: true, field: 'neighborhood' },
      city: { type: DataTypes.STRING(100), allowNull: true, field: 'city' },
      state: { type: DataTypes.STRING(2), allowNull: true, field: 'state' },
      isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_current' },
      validFrom: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_from' },
      validUntil: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_until' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'people',
      tableName: 'person_addresses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PersonAddress;
};
