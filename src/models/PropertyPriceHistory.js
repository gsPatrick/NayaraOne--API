'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyPriceHistory — tabela "real_estate"."property_price_history"
 * Histórico append-only de alterações de preço de uma OFERTA (não do imóvel físico — o Caderno
 * Técnico confirma que "Venda e locação são ofertas; não duplicar imóvel físico", e o histórico
 * segue a mesma lógica: é a oferta que muda de preço, o imóvel é o mesmo).
 */
module.exports = (sequelize) => {
  const PropertyPriceHistory = sequelize.define(
    'PropertyPriceHistory',
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
      offerId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'offer_id',
      },
      oldPrice: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'old_price',
      },
      newPrice: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: false,
        field: 'new_price',
      },
      reasonCode: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'reason_code',
      },
      changedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'changed_at',
      },
      changedBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'changed_by',
      },
    },
    {
      schema: 'real_estate',
      tableName: 'property_price_history',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PropertyPriceHistory;
};
