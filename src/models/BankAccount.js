'use strict';

const { DataTypes } = require('sequelize');

/**
 * BankAccount — tabela "finance"."bank_accounts"
 * Conta bancária/financeira da empresa ou de um proprietário — dados sensíveis, mascarados na aplicação.
 */
module.exports = (sequelize) => {
  const BankAccount = sequelize.define(
    'BankAccount',
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
      ownerPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'owner_person_id',
        comment: "Preenchido quando a conta pertence a um proprietário/terceiro",
      },
      bankCode: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'bank_code',
      },
      agency: {
        type: DataTypes.STRING(16),
        allowNull: true,
        field: 'agency',
      },
      accountNumber: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'account_number',
      },
      pixKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'pix_key',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING_COOLDOWN',
        field: 'status',
        comment: "Conta nova entra em período de resfriamento antes de elegível a pagamento",
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
      schema: 'finance',
      tableName: 'bank_accounts',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return BankAccount;
};
