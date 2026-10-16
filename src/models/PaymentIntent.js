'use strict';

const { DataTypes } = require('sequelize');

/**
 * PaymentIntent — tabela "finance"."payment_intents"
 * Intenção de pagamento com snapshot completo + SHA-256 dos dados aprovados. `snapshotJson` e
 * `snapshotHash` são imutáveis após a criação (só `status` e os carimbos evoluem) — é
 * exatamente isso que permite provar, na execução, que o que está sendo pago é o que foi
 * aprovado.
 */
module.exports = (sequelize) => {
  const PaymentIntent = sequelize.define(
    'PaymentIntent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financialEntryId: { type: DataTypes.UUID, allowNull: false, field: 'financial_entry_id' },
      snapshotJson: { type: DataTypes.JSONB, allowNull: false, field: 'snapshot_json' },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: false, field: 'snapshot_hash' },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: 'PENDING|APPROVED|SUBMITTED|EXECUTED|FAILED|CANCELLED',
      },
      bankAccountId: { type: DataTypes.UUID, allowNull: true, field: 'bank_account_id' },
      beneficiarySnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'beneficiary_snapshot' },
      paymentMethod: { type: DataTypes.STRING(16), allowNull: true, field: 'payment_method' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: true, field: 'idempotency_key' },
      externalSubmissionId: { type: DataTypes.STRING(255), allowNull: true, field: 'external_submission_id' },
      externalStatus: { type: DataTypes.STRING(64), allowNull: true, field: 'external_status' },
      submittedAt: { type: DataTypes.DATE, allowNull: true, field: 'submitted_at' },
      failedAt: { type: DataTypes.DATE, allowNull: true, field: 'failed_at' },
      failureReason: { type: DataTypes.TEXT, allowNull: true, field: 'failure_reason' },
      approvalRequestId: { type: DataTypes.UUID, allowNull: true, field: 'approval_request_id' },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      executedAt: { type: DataTypes.DATE, allowNull: true, field: 'executed_at' },
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      cancelReason: { type: DataTypes.TEXT, allowNull: true, field: 'cancel_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'finance',
      tableName: 'payment_intents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PaymentIntent;
};
