'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingPublicationResult — tabela "marketing"."publication_results".
 * Resultado de uma tentativa de publicação (M9-D401). Append-only: o banco recusa UPDATE e DELETE (MK002) e redige segredos de response_redacted_json.
 */
module.exports = (sequelize) => {
  const MarketingPublicationResult = sequelize.define(
    'MarketingPublicationResult',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      jobId: { type: DataTypes.UUID, allowNull: false, field: 'job_id' },
      attemptNo: { type: DataTypes.INTEGER, allowNull: false, field: 'attempt_no' },
      outcome: { type: DataTypes.STRING(24), allowNull: false, field: 'outcome' },
      externalPostId: { type: DataTypes.STRING(300), allowNull: true, field: 'external_post_id' },
      externalUrl: { type: DataTypes.TEXT, allowNull: true, field: 'external_url' },
      providerStatus: { type: DataTypes.STRING(120), allowNull: true, field: 'provider_status' },
      metricsJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'metrics_json' },
      responseRedactedJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'response_redacted_json' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'occurred_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    {
      schema: 'marketing',
      tableName: 'publication_results',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      paranoid: false,
      underscored: true,
    }
  );

  return MarketingPublicationResult;
};
