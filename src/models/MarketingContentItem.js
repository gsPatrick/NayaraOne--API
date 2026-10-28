'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingContentItem — tabela "marketing"."content_items".
 * Item de conteúdo de marketing (M9-D400): um dos 10 tipos, com pipeline de estados e versão corrente.
 */
module.exports = (sequelize) => {
  const MarketingContentItem = sequelize.define(
    'MarketingContentItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      type: { type: DataTypes.STRING(32), allowNull: false },
      title: { type: DataTypes.STRING(300), allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'DRAFT' },
      sourceEntityType: { type: DataTypes.STRING(80), allowNull: true, field: 'source_entity_type' },
      sourceEntityId: { type: DataTypes.UUID, allowNull: true, field: 'source_entity_id' },
      sourceVersion: { type: DataTypes.INTEGER, allowNull: true, field: 'source_version' },
      currentVersionId: { type: DataTypes.UUID, allowNull: true, field: 'current_version_id' },
      nayRunId: { type: DataTypes.UUID, allowNull: true, field: 'nay_run_id' },
      autopublishClass: { type: DataTypes.STRING(120), allowNull: true, field: 'autopublish_class' },
      campaignId: { type: DataTypes.UUID, allowNull: true, field: 'campaign_id' },
      updatesContentItemId: { type: DataTypes.UUID, allowNull: true, field: 'updates_content_item_id' },
      supersededBy: { type: DataTypes.UUID, allowNull: true, field: 'superseded_by' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'content_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingContentItem;
};
