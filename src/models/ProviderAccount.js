'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProviderAccount — "correspondent"."provider_accounts" (caderno do Marco 8).
 * O segredo do provider não mora aqui: `secretRef` é só o nome no cofre.
 */
module.exports = (sequelize) => {
  const ProviderAccount = sequelize.define(
    'ProviderAccount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      label: { type: DataTypes.STRING(120), allowNull: false },
      secretRef: { type: DataTypes.STRING(160), allowNull: false, field: 'secret_ref' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'provider_accounts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return ProviderAccount;
};
