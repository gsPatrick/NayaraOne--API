'use strict';

const { DataTypes } = require('sequelize');

/**
 * RentAdvance — tabela "finance"."rent_advances". Antecipação de aluguel: produto SEPARADO de
 * GuaranteedRentContract. Principal e custo/juros são contabilizados em FinancialEntry
 * distintos (principal_entry_id / cost_entry_id).
 */
module.exports = (sequelize) => {
  const RentAdvance = sequelize.define(
    'RentAdvance',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ELIGIBILITY_PENDING', field: 'status' },
      monthsAdvanced: { type: DataTypes.INTEGER, allowNull: false, field: 'months_advanced' },
      principalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'principal_amount' },
      costAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'cost_amount' },
      recoveredAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'recovered_amount' },
      proposedAt: { type: DataTypes.DATE, allowNull: true, field: 'proposed_at' },
      acceptedAt: { type: DataTypes.DATE, allowNull: true, field: 'accepted_at' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      principalEntryId: { type: DataTypes.UUID, allowNull: true, field: 'principal_entry_id' },
      costEntryId: { type: DataTypes.UUID, allowNull: true, field: 'cost_entry_id' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'rent_advances',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return RentAdvance;
};
