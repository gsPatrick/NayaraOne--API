'use strict';

const { DataTypes } = require('sequelize');

/**
 * CartVersion — tabela "crm"."cart_versions" (migration 20260101000286-create-crm-carts.js).
 * Snapshot append-only de cada versão de um carrinho (lista de imóveis daquela versão) —
 * "Carrinho versionado para saber o que foi enviado."
 */
module.exports = (sequelize) => {
  const CartVersion = sequelize.define(
    'CartVersion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      cartId: { type: DataTypes.UUID, allowNull: false, field: 'cart_id' },
      versionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'version_number' },
      propertyIdsJson: { type: DataTypes.JSONB, allowNull: false, field: 'property_ids_json' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'crm',
      tableName: 'cart_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return CartVersion;
};
