'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingContentVersion — tabela "marketing"."content_versions".
 * Versão imutável de um conteúdo (M9-D400): o banco recusa UPDATE de corpo, fatos e hashes (erro MK001).
 */
module.exports = (sequelize) => {
  const MarketingContentVersion = sequelize.define(
    'MarketingContentVersion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contentItemId: { type: DataTypes.UUID, allowNull: false, field: 'content_item_id' },
      versionNo: { type: DataTypes.INTEGER, allowNull: false, field: 'version_no' },
      bodyJson: { type: DataTypes.JSONB, allowNull: false, field: 'body_json' },
      factsSnapshotJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'facts_snapshot_json' },
      factsHash: { type: DataTypes.CHAR(64), allowNull: true, field: 'facts_hash' },
      templateId: { type: DataTypes.UUID, allowNull: true, field: 'template_id' },
      templateVersionNo: { type: DataTypes.INTEGER, allowNull: true, field: 'template_version_no' },
      modelName: { type: DataTypes.STRING(120), allowNull: true, field: 'model_name' },
      nayRunId: { type: DataTypes.UUID, allowNull: true, field: 'nay_run_id' },
      checksJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'checks_json' },
      contentHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'content_hash' },
      approvedBy: { type: DataTypes.STRING(160), allowNull: true, field: 'approved_by' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      approvedHash: { type: DataTypes.CHAR(64), allowNull: true, field: 'approved_hash' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'content_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingContentVersion;
};
