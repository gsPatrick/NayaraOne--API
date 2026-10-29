'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiRecommendation — tabela "ai"."ai_recommendations"
 * Recomendação/proposta gerada por um agente da NAY, sujeita a aprovação humana quando crítica.
 */
module.exports = (sequelize) => {
  const AiRecommendation = sequelize.define(
    'AiRecommendation',
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
      aiRunId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'ai_run_id',
      },
      relatedEntityType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'related_entity_type',
      },
      relatedEntityId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'related_entity_id',
      },
      recommendationType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'recommendation_type',
      },
      payloadJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'payload_json',
      },
      riskLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'LOW',
        field: 'risk_level',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: "PENDING|ACCEPTED|REJECTED|STALE|EXECUTED|EXECUTION_FAILED|EXPIRED",
      },
      decidedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'decided_by_user_id',
      },
      agentCode: { type: DataTypes.STRING(64), allowNull: true, field: 'agent_code' },
      title: { type: DataTypes.STRING(200), allowNull: true, field: 'title' },
      rationale: { type: DataTypes.TEXT, allowNull: true, field: 'rationale' },
      confidence: { type: DataTypes.DECIMAL(4, 3), allowNull: true, field: 'confidence' },
      proposedAction: { type: DataTypes.JSONB, allowNull: true, field: 'proposed_action' },
      decision: { type: DataTypes.STRING(12), allowNull: true, field: 'decision', comment: 'ACCEPTED|REJECTED' },
      decisionReason: { type: DataTypes.TEXT, allowNull: true, field: 'decision_reason' },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
      outcome: { type: DataTypes.STRING(20), allowNull: true, field: 'outcome', comment: 'EXECUTED|EXECUTION_FAILED|NOT_APPLICABLE' },
      outcomeDetail: { type: DataTypes.TEXT, allowNull: true, field: 'outcome_detail' },
      outcomeAt: { type: DataTypes.DATE, allowNull: true, field: 'outcome_at' },
      dedupKey: { type: DataTypes.STRING(64), allowNull: true, field: 'dedup_key' },
      targetUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'target_user_id',
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
      schema: 'ai',
      tableName: 'ai_recommendations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return AiRecommendation;
};
