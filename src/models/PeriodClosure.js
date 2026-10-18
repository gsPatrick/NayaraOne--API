'use strict';

const { DataTypes } = require('sequelize');

/**
 * PeriodClosure — tabela "finance"."period_closures"
 * Fechamento mensal de competência por empresa. Um registro por (companyId, referenceMonth).
 */
module.exports = (sequelize) => {
  const PeriodClosure = sequelize.define(
    'PeriodClosure',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      referenceMonth: {
        type: DataTypes.STRING(7),
        allowNull: false,
        field: 'reference_month',
        comment: 'YYYY-MM',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
        comment: 'OPEN|REVIEW|CLOSED',
      },
      // F02 — conferências explícitas exigidas pelo Caderno §16 antes do fechamento.
      thirdPartyCheckedAt: { type: DataTypes.DATE, allowNull: true, field: 'third_party_checked_at' },
      thirdPartyCheckedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'third_party_checked_by_user_id' },
      thirdPartyCheckNote: { type: DataTypes.TEXT, allowNull: true, field: 'third_party_check_note' },
      thirdPartyBalanceAtCheck: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'third_party_balance_at_check' },
      commissionsReviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'commissions_reviewed_at' },
      commissionsReviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'commissions_reviewed_by_user_id' },
      commissionsReviewNote: { type: DataTypes.TEXT, allowNull: true, field: 'commissions_review_note' },
      commissionsFingerprintAtReview: { type: DataTypes.STRING(64), allowNull: true, field: 'commissions_fingerprint_at_review' },
      currentSnapshotId: { type: DataTypes.UUID, allowNull: true, field: 'current_snapshot_id' },
      closedAt: { type: DataTypes.DATE, allowNull: true, field: 'closed_at' },
      closedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'closed_by_user_id' },
      reopenedAt: { type: DataTypes.DATE, allowNull: true, field: 'reopened_at' },
      reopenedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reopened_by_user_id' },
      reopenReason: { type: DataTypes.TEXT, allowNull: true, field: 'reopen_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'period_closures',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PeriodClosure;
};
