'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyAddress — tabela "real_estate"."property_addresses"
 * Endereço interno de um imóvel (1:1 via properties.address_id). Estrutura de colunas é
 * INFERÊNCIA de convenção de mercado (endereço brasileiro padrão) — o Caderno Técnico confirma
 * a existência do relacionamento mas não detalha colunas. Sem RLS própria (ver migration
 * 20260101000075) — acesso sempre via JOIN com "real_estate"."properties".
 */
module.exports = (sequelize) => {
  const PropertyAddress = sequelize.define(
    'PropertyAddress',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      zipCode: {
        type: DataTypes.STRING(9),
        allowNull: false,
        field: 'zip_code',
      },
      street: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'street',
      },
      number: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'number',
      },
      complement: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'complement',
      },
      neighborhood: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'neighborhood',
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'city',
      },
      state: {
        type: DataTypes.STRING(2),
        allowNull: false,
        field: 'state',
      },
    },
    {
      schema: 'real_estate',
      tableName: 'property_addresses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PropertyAddress;
};
