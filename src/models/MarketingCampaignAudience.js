'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingCampaignAudience — tabela "marketing"."campaign_audiences".
 * Público da campanha (M9-D400): só referencia pessoas da mesma empresa da campanha.
 */
module.exports = (sequelize) => {
  const MarketingCampaignAudience = sequelize.define(
    'MarketingCampaignAudience',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      campaignId: { type: DataTypes.UUID, allowNull: false, field: 'campaign_id' },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      filterJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'filter_json' },
      purpose: { type: DataTypes.STRING(40), allowNull: false },
      sizeFrozen: { type: DataTypes.INTEGER, allowNull: true, field: 'size_frozen' },
      frozenAt: { type: DataTypes.DATE, allowNull: true, field: 'frozen_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'campaign_audiences',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingCampaignAudience;
};
