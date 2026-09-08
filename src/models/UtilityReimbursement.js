'use strict';

const { DataTypes } = require('sequelize');

/**
 * UtilityReimbursement — tabela "finance"."utility_reimbursements". Reembolso a receber
 * gerado quando a imobiliária paga uma conta de utilidade que era responsabilidade da outra
 * parte. `financialEntryId` referencia o FinancialEntry real (RECEIVABLE) criado junto.
 */
module.exports = (sequelize) => {
  const UtilityReimbursement = sequelize.define(
    'UtilityReimbursement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      utilityObligationId: { type: DataTypes.UUID, allowNull: false, field: 'utility_obligation_id' },
      paidByParty: { type: DataTypes.STRING(16), allowNull: false, field: 'paid_by_party' },
      owedByParty: { type: DataTypes.STRING(16), allowNull: false, field: 'owed_by_party' },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'amount' },
      financialEntryId: { type: DataTypes.UUID, allowNull: true, field: 'financial_entry_id' },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'finance',
      tableName: 'utility_reimbursements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return UtilityReimbursement;
};
