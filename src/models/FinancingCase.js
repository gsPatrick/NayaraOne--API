'use strict';

const { DataTypes } = require('sequelize');

/**
 * FinancingCase — tabela "correspondent"."financing_cases" (Marco 8, Caderno "CORRESPONDENTE
 * BANCÁRIO + NC + FINANCIAMENTOS"). Um registro por operação de financiamento. `status` aqui só
 * alcança DRAFT nesta fase (Fase 1) — a máquina de estados completa é Fase 6.
 */
module.exports = (sequelize) => {
  const FinancingCase = sequelize.define(
    'FinancingCase',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      propertyId: { type: DataTypes.UUID, allowNull: true, field: 'property_id' },
      // Oportunidade de CRM vinculada (opcional, Marco 8 Fase 9) — só referência; atualizada via
      // evento/audit log (correspondentCrmSync.service.js), nunca escrita direta na Opportunity.
      opportunityId: { type: DataTypes.UUID, allowNull: true, field: 'opportunity_id' },
      // Sinalização de possível duplicata (Marco 8 Fase 11) — nunca bloqueia a criação, só
      // sinaliza para revisão humana. Ver correspondentDuplicate.service.js.
      duplicateFingerprint: { type: DataTypes.STRING(64), allowNull: true, field: 'duplicate_fingerprint' },
      possibleDuplicateOfCaseId: { type: DataTypes.UUID, allowNull: true, field: 'possible_duplicate_of_case_id' },
      providerCode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'sandbox', field: 'provider_code' },
      product: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'FINANCIAMENTO_IMOBILIARIO', field: 'product' },
      purpose: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'RESIDENCIAL', field: 'purpose' },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      // Contador dedicado de idempotência de submissão (Marco 8 Fase 5) — DELIBERADAMENTE
      // separado de `lockVersion` (controle otimista do Sequelize, que muda em QUALQUER save,
      // inclusive como efeito colateral de uma submissão com sucesso). Só muda via
      // acknowledgeUnknownSubmission. Ver migration 20260101000342.
      submissionVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'submission_version' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'correspondent',
      tableName: 'financing_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      version: 'lockVersion',
      underscored: true,
    }
  );
  return FinancingCase;
};
