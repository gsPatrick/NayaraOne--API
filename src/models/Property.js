'use strict';

const { DataTypes } = require('sequelize');

/**
 * Property — tabela "real_estate"."properties"
 * Imóvel administrado/comercializado pela imobiliária.
 *
 * publication_status/availability_status substituem o antigo campo único "status" (Marco 3
 * ainda não formalmente aceito à época do alinhamento ao Caderno Técnico — ver migration
 * 20260101000076). "Venda e locação são ofertas; não duplicar imóvel físico" — o preço/tipo de
 * negócio vive em PropertyOffer, nunca aqui.
 */
module.exports = (sequelize) => {
  const Property = sequelize.define(
    'Property',
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
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'title',
      },
      internalCode: {
        type: DataTypes.STRING(40),
        allowNull: false,
        field: 'internal_code',
        comment: 'Código comercial. UNIQUE(group_id, internal_code).',
      },
      propertyType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'property_type',
        comment: 'Casa/apto/terreno/etc — texto livre validado por lista no app, não ENUM rígido no banco.',
      },
      addressId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'address_id',
      },
      registryNumber: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'registry_number',
        comment: 'Matrícula',
      },
      registryOffice: {
        type: DataTypes.STRING(150),
        allowNull: true,
        field: 'registry_office',
        comment: 'Cartório',
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        field: 'latitude',
      },
      longitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        field: 'longitude',
      },
      // Colunas legadas de endereço "achatado" ainda existentes na tabela — mantidas por
      // compatibilidade até uma migração de dados formal para property_addresses; o endereço
      // canônico passa a ser address_id -> PropertyAddress.
      addressLine: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'address_line',
      },
      city: {
        type: DataTypes.STRING(128),
        allowNull: true,
        field: 'city',
      },
      state: {
        type: DataTypes.STRING(2),
        allowNull: true,
        field: 'state',
      },
      zipCode: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'zip_code',
      },
      areaTotalM2: {
        type: DataTypes.DECIMAL(9, 6),
        allowNull: true,
        field: 'area_total_m2',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
      },
      bedrooms: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'bedrooms',
      },
      parkingSpots: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'parking_spots',
      },
      // Características de forma variável (mobiliado, piscina, elevador, ano de construção,
      // vagas cobertas/descobertas...) — ver migration ...093.
      attributesJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'attributes_json',
      },
      publicationStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'publication_status',
        comment: 'DRAFT|READY|PUBLISHED|INACTIVE',
      },
      availabilityStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'AVAILABLE',
        field: 'availability_status',
        comment: 'AVAILABLE|SOLD|RENTED|WITHDRAWN',
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
      schema: 'real_estate',
      tableName: 'properties',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Property;
};
