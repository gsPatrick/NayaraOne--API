'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProviderSubmission — tabela "correspondent"."provider_submissions" (Marco 8 Fase 5). Registra
 * cada tentativa de submissão de um financing_case a um provider, com idempotência por
 * `idempotency_key` (UNIQUE por empresa — ver migration).
 */
module.exports = (sequelize) => {
  const ProviderSubmission = sequelize.define(
    'ProviderSubmission',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      financingCaseId: { type: DataTypes.UUID, allowNull: false, field: 'financing_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, field: 'provider_code' },
      idempotencyKey: { type: DataTypes.STRING(160), allowNull: false, field: 'idempotency_key' },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: false, field: 'snapshot_hash' },
      requestSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'request_snapshot' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      externalCaseId: { type: DataTypes.STRING(160), allowNull: true, field: 'external_case_id' },
      responseSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'response_snapshot' },
      failureReason: { type: DataTypes.TEXT, allowNull: true, field: 'failure_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'provider_submissions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return ProviderSubmission;
};
