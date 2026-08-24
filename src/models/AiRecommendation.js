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
        comment: "PENDING|ACCEPTED|REJECTED|AUTO_APPLIED",
      },
      decidedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'decided_by_user_id',
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
