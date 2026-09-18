'use strict';

const { DataTypes } = require('sequelize');

/**
 * Reconciliation — tabela "finance"."reconciliations"
 * Vínculo de conciliação entre um lançamento do ledger e uma transação bancária.
 */
module.exports = (sequelize) => {
  const Reconciliation = sequelize.define(
    'Reconciliation',
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
      financialEntryId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'financial_entry_id',
      },
      bankTransactionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'bank_transaction_id',
      },
      matchGroupId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'match_group_id',
        comment: 'Amarra todas as linhas de uma conciliação N:N (NULL nas conciliações 1:1)',
      },
      matchedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'matched_at',
      },
      matchedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'matched_by_user_id',
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
    },
    {
      schema: 'finance',
      tableName: 'reconciliations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Reconciliation;
};
