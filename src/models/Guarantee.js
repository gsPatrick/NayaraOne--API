'use strict';

const { DataTypes } = require('sequelize');

/**
 * Guarantee — tabela "legal"."guarantees"
 * Garantia locatícia vinculada a um contrato (fiador, seguro-fiança, depósito caução,
 * título de capitalização).
 */
module.exports = (sequelize) => {
  const Guarantee = sequelize.define(
    'Guarantee',
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
      contractId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'contract_id',
      },
      guaranteeType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'guarantee_type',
        comment: "GUARANTOR|INSURANCE|SECURITY_DEPOSIT|CAPITALIZATION|OTHER (códigos do livro; DEPOSIT/CAPITALIZATION_TITLE só como apelido)",
      },
      guarantorPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'guarantor_person_id',
      },
      value: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'value',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
      },
      startsAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'ends_at',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      // FIX AUD-009 (auditoria externa, 09/10/2026): a coluna "replaced_by_guarantee_id"
      // (migration 20260101000289) JÁ existe fisicamente neste banco (confirmado via
      // information_schema.columns), mas a nota de ambiente que acompanhava este arquivo dizia
      // o contrário e o campo tinha ficado fora do model — mesmo padrão de bug do fallback de
      // bootstrap encontrado em construction/projects.service.js#hasOpenCriticalNonconformity.
      // Resultado prático: `replaceGuarantee` (guarantees.service.js) atribuía
      // `oldGuarantee.replacedByGuaranteeId` só na instância em memória — nunca persistia, então
      // o vínculo "quem substituiu quem" (Caderno Anexo I "9. Garantias locatícias" —
      // "contrato não perde histórico quando a garantia é substituída") só existia no JSON de
      // auditoria, não na própria linha da garantia antiga.
      // Fechamento M5 (Caderno §9): dados de cada tipo de garantia (migration 20260101009990).
      additionalGuarantorPersonIds: { type: DataTypes.JSONB, allowNull: true, field: 'additional_guarantor_person_ids' },
      documentFileIds: { type: DataTypes.JSONB, allowNull: true, field: 'document_file_ids' },
      acceptanceFileId: { type: DataTypes.UUID, allowNull: true, field: 'acceptance_file_id' },
      acceptedAt: { type: DataTypes.DATE, allowNull: true, field: 'accepted_at' },
      providerName: { type: DataTypes.STRING(160), allowNull: true, field: 'provider_name' },
      policyNumber: { type: DataTypes.STRING(80), allowNull: true, field: 'policy_number' },
      policyFileId: { type: DataTypes.UUID, allowNull: true, field: 'policy_file_id' },
      premiumInstallments: { type: DataTypes.JSONB, allowNull: true, field: 'premium_installments' },
      annualPremium: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'annual_premium' },
      renewalDueAt: { type: DataTypes.DATEONLY, allowNull: true, field: 'renewal_due_at' },
      autoRenew: { type: DataTypes.BOOLEAN, allowNull: true, field: 'auto_renew' },
      financeEntryId: { type: DataTypes.UUID, allowNull: true, field: 'finance_entry_id' },
      holderPersonId: { type: DataTypes.UUID, allowNull: true, field: 'holder_person_id' },
      certificateNumber: { type: DataTypes.STRING(80), allowNull: true, field: 'certificate_number' },
      certificateFileId: { type: DataTypes.UUID, allowNull: true, field: 'certificate_file_id' },
      redemptionAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'redemption_amount' },
      homologatedFlowCode: { type: DataTypes.STRING(60), allowNull: true, field: 'homologated_flow_code' },
      flowData: { type: DataTypes.JSONB, allowNull: true, field: 'flow_data' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      replacedByGuaranteeId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'replaced_by_guarantee_id',
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
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'legal',
      tableName: 'guarantees',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Guarantee;
};
