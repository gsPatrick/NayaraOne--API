'use strict';

const { DataTypes } = require('sequelize');

/**
 * NayDraftSuggestion — legal.nay_draft_suggestions (migration 20260101015104; Caderno M5 §17 "Sugere minuta usando biblioteca
 * homologada"): a minuta montada pelo servidor só com versões de cláusula homologadas, aguardando a decisão de uma pessoa.
 * Texto, hash e versões usadas são imutáveis (gatilho); a decisão (ACCEPTED/DISCARDED) é única.
 */
module.exports = (sequelize) => sequelize.define(
  'NayDraftSuggestion',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
    aiRunId: { type: DataTypes.UUID, allowNull: true, field: 'ai_run_id' },
    method: { type: DataTypes.STRING(16), allowNull: false, field: 'method' },
    modeReason: { type: DataTypes.STRING(64), allowNull: true, field: 'mode_reason' },
    providerCode: { type: DataTypes.STRING(60), allowNull: true, field: 'provider_code' },
    modelCode: { type: DataTypes.STRING(120), allowNull: true, field: 'model_code' },
    content: { type: DataTypes.TEXT, allowNull: false, field: 'content' },
    contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
    clauseVersionIds: { type: DataTypes.JSONB, allowNull: false, field: 'clause_version_ids' },
    groundingJson: { type: DataTypes.JSONB, allowNull: false, field: 'grounding_json' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING_REVIEW', field: 'status' },
    decidedBy: { type: DataTypes.UUID, allowNull: true, field: 'decided_by' },
    decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
    decisionReason: { type: DataTypes.STRING(500), allowNull: true, field: 'decision_reason' },
    contractVersionId: { type: DataTypes.UUID, allowNull: true, field: 'contract_version_id' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'legal', tableName: 'nay_draft_suggestions', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
