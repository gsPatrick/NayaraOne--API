'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingTemplate — tabela "marketing"."templates".
 * Template versionado de conteúdo ou mensagem (M9-D400, MKT-010).
 */
module.exports = (sequelize) => {
  const MarketingTemplate = sequelize.define(
    'MarketingTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(80), allowNull: false },
      versionNo: { type: DataTypes.INTEGER, allowNull: false, field: 'version_no' },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      channel: { type: DataTypes.STRING(16), allowNull: true },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT' },
      body: { type: DataTypes.TEXT, allowNull: false },
      variablesJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'variables_json' },
      brandTokensJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'brand_tokens_json' },
      officialTemplateRef: { type: DataTypes.STRING(200), allowNull: true, field: 'official_template_ref' },
      contentHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'content_hash' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'templates',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingTemplate;
};
