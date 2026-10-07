'use strict';

const { DataTypes } = require('sequelize');

/**
 * InsuranceProviderSubmission — tabela "procurement"."insurance_provider_submissions".
 * SEM RLS de propósito — mesmo padrão de SignatureProviderRouting/BankPaymentProviderRouting:
 * o webhook público da seguradora chega sem JWT/tenant conhecido, essa tabela resolve
 * group_id/company_id ANTES de abrir qualquer transação com SET LOCAL.
 */
module.exports = (sequelize) => {
  const InsuranceProviderSubmission = sequelize.define(
    'InsuranceProviderSubmission',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      policyId: { type: DataTypes.UUID, allowNull: true, field: 'policy_id' },
      claimId: { type: DataTypes.UUID, allowNull: true, field: 'claim_id' },
      provider: { type: DataTypes.STRING(32), allowNull: false },
      submissionType: { type: DataTypes.STRING(16), allowNull: false, field: 'submission_type' },
      externalSubmissionId: { type: DataTypes.STRING(255), allowNull: false, field: 'external_submission_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING' },
    },
    {
      schema: 'procurement',
      tableName: 'insurance_provider_submissions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return InsuranceProviderSubmission;
};
