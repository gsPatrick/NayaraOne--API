'use strict';

const { DataTypes } = require('sequelize');

/** AiChunk — tabela "ai"."chunks" (M9-D023): pedaço indexado de uma fonte, com metadados completos, vetor e estado. */
module.exports = (sequelize) => sequelize.define(
  'AiChunk',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    ingestionId: { type: DataTypes.UUID, allowNull: false, field: 'ingestion_id' },
    sourceId: { type: DataTypes.UUID, allowNull: false, field: 'source_id' },
    sourceType: { type: DataTypes.STRING(20), allowNull: false, field: 'source_type' },
    sourceVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'source_version' },
    chunkIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'chunk_index' },
    contentRedacted: { type: DataTypes.TEXT, allowNull: false, field: 'content_redacted' },
    contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
    tokensCount: { type: DataTypes.INTEGER, allowNull: false, field: 'tokens_count' },
    classification: { type: DataTypes.STRING(12), allowNull: false, field: 'classification' },
    effectiveFrom: { type: DataTypes.DATE, allowNull: false, field: 'effective_from' },
    effectiveUntil: { type: DataTypes.DATE, allowNull: true, field: 'effective_until' },
    requiredPermission: { type: DataTypes.STRING(64), allowNull: false, field: 'required_permission' },
    ownerScope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'COMPANY', field: 'owner_scope' },
    ownerUserId: { type: DataTypes.UUID, allowNull: true, field: 'owner_user_id' },
    embedding: { type: DataTypes.ARRAY(DataTypes.DOUBLE), allowNull: false, field: 'embedding' },
    embeddingNorm: { type: DataTypes.DOUBLE, allowNull: false, field: 'embedding_norm' },
    embeddingModel: { type: DataTypes.STRING(128), allowNull: false, field: 'embedding_model' },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
  },
  { schema: 'ai', tableName: 'chunks', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
