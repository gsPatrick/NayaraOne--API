'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiSource — tabela "ai"."ai_sources"
 * Fonte documental/interna citada por uma resposta da NAY (rastreabilidade antialucinação).
 */
module.exports = (sequelize) => {
  const AiSource = sequelize.define(
    'AiSource',
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
        allowNull: false,
        field: 'ai_run_id',
      },
      sourceType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'source_type',
        comment: "READ_MODEL|DOCUMENT_CHUNK|KNOWLEDGE_ENTRY|MEMORY|TOOL_RESULT",
      },
      sourceRef: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'source_ref',
      },
      excerpt: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'excerpt',
      },
      sourceVersion: { type: DataTypes.STRING(60), allowNull: true, field: 'source_version' },
      classification: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'INTERNAL', field: 'classification' },
      effectiveFrom: { type: DataTypes.DATE, allowNull: true, field: 'effective_from' },
      effectiveUntil: { type: DataTypes.DATE, allowNull: true, field: 'effective_until' },
      retrievedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'retrieved_at' },
      relevanceScore: { type: DataTypes.DECIMAL(6, 5), allowNull: true, field: 'relevance_score' },
      usedInAnswer: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'used_in_answer' },
      statusAtRetrieval: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'VIGENTE', field: 'status_at_retrieval' },
      contentHash: { type: DataTypes.STRING(64), allowNull: true, field: 'content_hash' },
      contentPurgedAt: { type: DataTypes.DATE, allowNull: true, field: 'content_purged_at' },
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
    },
    {
      schema: 'ai',
      tableName: 'ai_sources',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AiSource;
};
