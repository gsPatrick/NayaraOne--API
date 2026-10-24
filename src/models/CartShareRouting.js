'use strict';

const { DataTypes } = require('sequelize');

/**
 * CartShareRouting — tabela "crm"."cart_share_routing" (migration
 * 20260101000286-create-crm-carts.js). EXCEÇÃO DELIBERADA sem RLS, mesmo princípio de
 * SignatureProviderRouting/BankPaymentProviderRouting: o visitante do link público não tem
 * tenant/JWT nenhum. Guarda só um token opaco -> (group_id, company_id, cart_id).
 */
module.exports = (sequelize) => {
  const CartShareRouting = sequelize.define(
    'CartShareRouting',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      token: { type: DataTypes.STRING(128), allowNull: false, field: 'token' },
      cartId: { type: DataTypes.UUID, allowNull: false, field: 'cart_id' },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    },
    {
      schema: 'crm',
      tableName: 'cart_share_routing',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return CartShareRouting;
};
