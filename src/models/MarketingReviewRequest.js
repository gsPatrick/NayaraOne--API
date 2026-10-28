'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingReviewRequest — tabela "marketing"."review_requests".
 * Pedido de avaliação (M9-D401): nota de satisfação interna e nota pública devolvida pela plataforma.
 */
module.exports = (sequelize) => {
  const MarketingReviewRequest = sequelize.define(
    'MarketingReviewRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: false, field: 'person_id' },
      sourceEntityType: { type: DataTypes.STRING(80), allowNull: false, field: 'source_entity_type' },
      sourceEntityId: { type: DataTypes.UUID, allowNull: false, field: 'source_entity_id' },
      satisfactionScore: { type: DataTypes.INTEGER, allowNull: true, field: 'satisfaction_score' },
      platform: { type: DataTypes.STRING(40), allowNull: true, field: 'platform' },
      publicRating: { type: DataTypes.INTEGER, allowNull: true, field: 'public_rating' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      feedbackCaseId: { type: DataTypes.UUID, allowNull: true, field: 'feedback_case_id' },
      channel: { type: DataTypes.STRING(16), allowNull: false, field: 'channel' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'review_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingReviewRequest;
};
