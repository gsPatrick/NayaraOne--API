'use strict';

const { DataTypes } = require('sequelize');

/** AiIngestion — tabela "ai"."ingestions" (M9-D022): uma ingestão de arquivo, URL ou conhecimento homologado no índice da NAY. */
module.exports = (sequelize) => sequelize.define(
  'AiIngestion',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    sourceKind: { type: DataTypes.STRING(20), allowNull: false, field: 'source_kind' },
    sourceRef: { type: DataTypes.STRING(2048), allowNull: false, field: 'source_ref' },
    sourceId: { type: DataTypes.UUID, allowNull: false, field: 'source_id' },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING', field: 'status' },
    step: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'AUTHORIZE', field: 'step' },
    errorCode: { type: DataTypes.STRING(64), allowNull: true, field: 'error_code' },
    contentHash: { type: DataTypes.STRING(64), allowNull: true, field: 'content_hash' },
    classification: { type: DataTypes.STRING(12), allowNull: true, field: 'classification' },
    sourceVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'source_version' },
    secretsRemoved: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'secrets_removed' },
    activeContentDiscarded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'active_content_discarded' },
    chunksCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'chunks_count' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'started_at' },
    finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
  },
  { schema: 'ai', tableName: 'ingestions', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
