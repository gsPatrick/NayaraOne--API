'use strict';

const { DataTypes } = require('sequelize');

/**
 * LeaseObligationCycle — "legal"."lease_obligation_cycles" (fechamento M5, livro §12): um ciclo por vencimento de cada
 * obrigação da locação, com status (OPEN, OVERDUE, PAID, WAIVED), comprovante, quem pagou e a cobrança aberta no atraso.
 * Sem exclusão (nem lógica): o ciclo vencido continua depois do encerramento do contrato.
 */
module.exports = (sequelize) => sequelize.define(
  'LeaseObligationCycle',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    obligationId: { type: DataTypes.UUID, allowNull: false, field: 'obligation_id' },
    contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
    dueOn: { type: DataTypes.DATEONLY, allowNull: false, field: 'due_on' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'OPEN', field: 'status' },
    paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
    paidByParty: { type: DataTypes.STRING(16), allowNull: true, field: 'paid_by_party' },
    amount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'amount' },
    proofFileId: { type: DataTypes.UUID, allowNull: true, field: 'proof_file_id' },
    reimbursementId: { type: DataTypes.UUID, allowNull: true, field: 'reimbursement_id' },
    overdueSince: { type: DataTypes.DATE, allowNull: true, field: 'overdue_since' },
    collectionTaskId: { type: DataTypes.UUID, allowNull: true, field: 'collection_task_id' },
    waivedReason: { type: DataTypes.TEXT, allowNull: true, field: 'waived_reason' },
    lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  {
    schema: 'legal',
    tableName: 'lease_obligation_cycles',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    version: 'lockVersion',
    underscored: true,
  }
);
