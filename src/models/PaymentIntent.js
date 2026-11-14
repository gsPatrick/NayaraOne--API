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
      // M9-D228: o que a tela mostra enquanto a ordem espera o banco (fila, envio incerto ou aceita sem status final): nunca "pago" por presunção.
      statusMessage: {
        type: DataTypes.VIRTUAL,
        get() { return this.getDataValue('status') === 'EXECUTING' && this.getDataValue('submissionPhase') !== 'NOT_STARTED' ? 'Aguardando confirmação do banco' : null; },
      },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: false, field: 'snapshot_hash' },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'status',
        comment: 'DRAFT|PENDING_APPROVAL|APPROVED|EXECUTING|CONFIRMED|FAILED|CANCELED (Guia M4 §3, DEC-056)',
      },
      // DEC-056: fase do envio ao banco enquanto EXECUTING (NOT_STARTED|SUBMITTING|SUBMITTED|UNCERTAIN).
      submissionPhase: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'NOT_STARTED', field: 'submission_phase' },
      // Guia §3 amount / Caderno §8.2: o valor (parcela) desta intenção, que pode ser parte do saldo do lançamento.
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'amount' },
      installmentNumber: { type: DataTypes.INTEGER, allowNull: true, field: 'installment_number' },
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
      uncertainSince: { type: DataTypes.DATE, allowNull: true, field: 'uncertain_since' },
      lastReconciledAt: { type: DataTypes.DATE, allowNull: true, field: 'last_reconciled_at' },
      reconciliationAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'reconciliation_attempts' },
      // M9-D237: o pagamento casou com uma entrada do extrato (conciliado); não muda o estado da intenção.
      reconciledAt: { type: DataTypes.DATE, allowNull: true, field: 'reconciled_at' },
      reconciledEntryId: { type: DataTypes.UUID, allowNull: true, field: 'reconciled_entry_id' },
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
