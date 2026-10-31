'use strict';

const { DataTypes } = require('sequelize');

/**
 * Cart — tabela "crm"."carts" (migration 20260101000286-create-crm-carts.js).
 * Carrinho de imóveis compartilhável — item 3 do ciclo de auditoria externa Marco 3.
 */
module.exports = (sequelize) => {
  const Cart = sequelize.define(
    'Cart',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      opportunityId: { type: DataTypes.UUID, allowNull: false, field: 'opportunity_id' },
      currentVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'current_version' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'crm',
      tableName: 'carts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Cart;
};
