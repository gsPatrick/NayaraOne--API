'use strict';

const { DataTypes } = require('sequelize');

/**
 * LegalCase — tabela "legal"."legal_cases"
 * Processo/caso jurídico (contencioso ou consultivo) vinculado a contrato/imóvel/pessoa.
 */
module.exports = (sequelize) => {
  const LegalCase = sequelize.define(
    'LegalCase',
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
        allowNull: true,
        field: 'contract_id',
      },
      propertyId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'property_id',
      },
      responsibleUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'responsible_user_id',
      },
      caseNumber: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'case_number',
      },
      caseType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'case_type',
        comment: "LITIGATION|CONSULTATIVE|COLLECTION",
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      summary: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'summary',
      },
      // M5-26: fase processual (lista aberta — ver LEGAL_CASE_PHASES em legalCases.service.js).
      phase: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'phase',
      },
      // M5-27: quem recebe o alerta escalado quando o responsável não age em um prazo vencido.
      escalationUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'escalation_user_id',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      // Legal hold (auditoria Nayara 14/10/2026, §16/JUR-010/011): enquanto true, bloqueia
      // mudança de status/fase do processo (ver assertNotOnLegalHold em legalCases.service.js).
      legalHold: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'legal_hold',
      },
      legalHoldReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'legal_hold_reason',
      },
      legalHoldSetBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'legal_hold_set_by',
      },
      legalHoldSetAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'legal_hold_set_at',
      },
      // M45 (Caderno M5 §14): órgão, classe, valor ESTIMADO (nunca recebível) e risco.
      court: { type: DataTypes.STRING(160), allowNull: true, field: 'court' },
      caseClass: { type: DataTypes.STRING(120), allowNull: true, field: 'case_class' },
      estimatedAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'estimated_amount' },
      riskLevel: { type: DataTypes.STRING(16), allowNull: true, field: 'risk_level' },
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
      tableName: 'legal_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return LegalCase;
};
