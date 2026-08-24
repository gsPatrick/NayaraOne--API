'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyOffer — tabela "real_estate"."property_offers"
 * Oferta comercial vigente de um imóvel (venda, locação ou temporada).
 *
 * confidentialMinPrice NUNCA deve ser incluído em uma resposta servida a um contexto público
 * (site/portais/IA pública) — a omissão é responsabilidade do service/serializer que monta a
 * resposta pública, não deste model. Para o admin/mock atual (tudo interno) o campo é
 * retornado normalmente.
 */
module.exports = (sequelize) => {
  const PropertyOffer = sequelize.define(
    'PropertyOffer',
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
      offerType: {
        type: DataTypes.STRING(30),
        allowNull: false,
        field: 'offer_type',
        comment: 'SALE|RENT|SEASONAL',
      },
      askingPrice: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'asking_price',
        comment: 'Preço atual/público',
      },
      confidentialMinPrice: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'confidential_min_price',
        comment: 'Preço mínimo — NUNCA exposto em endpoint público.',
      },
      acceptsFinancing: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        field: 'accepts_financing',
      },
      acceptsTrade: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        field: 'accepts_trade',
        comment: 'Aceita permuta',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
        comment: 'ACTIVE|PAUSED|CLOSED (SUPERSEDED também usado internamente pela regra de supersede)',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at',
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
      tableName: 'property_offers',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return PropertyOffer;
};
