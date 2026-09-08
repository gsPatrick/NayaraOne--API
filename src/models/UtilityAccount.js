'use strict';

const { DataTypes } = require('sequelize');

/**
 * UtilityAccount — tabela "finance"."utility_accounts". Registro de conta/titularidade junto
 * à concessionária para uma UtilityObligation.
 */
module.exports = (sequelize) => {
  const UtilityAccount = sequelize.define(
    'UtilityAccount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      utilityObligationId: { type: DataTypes.UUID, allowNull: false, field: 'utility_obligation_id' },
      provider: { type: DataTypes.STRING(120), allowNull: false, field: 'provider' },
      accountNumber: { type: DataTypes.STRING(60), allowNull: false, field: 'account_number' },
      holderPersonId: { type: DataTypes.UUID, allowNull: true, field: 'holder_person_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'utility_accounts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return UtilityAccount;
};
