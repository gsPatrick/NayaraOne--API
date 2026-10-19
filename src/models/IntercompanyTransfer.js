'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntercompanyTransfer — tabela "finance"."intercompany_transfers"
 * Transferência formal entre empresas do mesmo grupo. `companyId` é SEMPRE a empresa de
 * origem (CHECK no banco garante company_id = from_company_id) — ver a decisão de RLS
 * documentada na migration 20260101000134.
 */
module.exports = (sequelize) => {
  const IntercompanyTransfer = sequelize.define(
    'IntercompanyTransfer',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      fromCompanyId: { type: DataTypes.UUID, allowNull: false, field: 'from_company_id' },
      toCompanyId: { type: DataTypes.UUID, allowNull: false, field: 'to_company_id' },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: 'amount' },
      reason: { type: DataTypes.TEXT, allowNull: true, field: 'reason' },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: 'PENDING_APPROVAL|REJECTED|PENDING|RECONCILED',
      },
      // Só existem depois da aprovação (§15: os dois lados nascem quando outra pessoa aprova).
      fromEntryId: { type: DataTypes.UUID, allowNull: true, field: 'from_entry_id' },
      toEntryId: { type: DataTypes.UUID, allowNull: true, field: 'to_entry_id' },
      evidenceFileId: { type: DataTypes.UUID, allowNull: true, field: 'evidence_file_id' },
      fromBankAccountId: { type: DataTypes.UUID, allowNull: true, field: 'from_bank_account_id' },
      toBankAccountId: { type: DataTypes.UUID, allowNull: true, field: 'to_bank_account_id' },
      requestedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'requested_by_user_id' },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      rejectedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'rejected_by_user_id' },
      rejectedAt: { type: DataTypes.DATE, allowNull: true, field: 'rejected_at' },
      rejectionReason: { type: DataTypes.TEXT, allowNull: true, field: 'rejection_reason' },
      reconciledAt: { type: DataTypes.DATE, allowNull: true, field: 'reconciled_at' },
      reconciledByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reconciled_by_user_id' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'intercompany_transfers',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return IntercompanyTransfer;
};
