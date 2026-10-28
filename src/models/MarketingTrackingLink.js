'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingTrackingLink — tabela "marketing"."tracking_links".
 * Link rastreável (M9-D401): short_code único global, UTMs e assinatura HMAC.
 */
module.exports = (sequelize) => {
  const MarketingTrackingLink = sequelize.define(
    'MarketingTrackingLink',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      campaignId: { type: DataTypes.UUID, allowNull: true, field: 'campaign_id' },
      contentItemId: { type: DataTypes.UUID, allowNull: true, field: 'content_item_id' },
      shortCode: { type: DataTypes.STRING(64), allowNull: false, field: 'short_code' },
      targetUrl: { type: DataTypes.TEXT, allowNull: false, field: 'target_url' },
      utmSource: { type: DataTypes.STRING(200), allowNull: true, field: 'utm_source' },
      utmMedium: { type: DataTypes.STRING(200), allowNull: true, field: 'utm_medium' },
      utmCampaign: { type: DataTypes.STRING(200), allowNull: true, field: 'utm_campaign' },
      utmContent: { type: DataTypes.STRING(200), allowNull: true, field: 'utm_content' },
      utmTerm: { type: DataTypes.STRING(200), allowNull: true, field: 'utm_term' },
      channel: { type: DataTypes.STRING(16), allowNull: false, field: 'channel' },
      signature: { type: DataTypes.STRING(128), allowNull: false, field: 'signature' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'tracking_links',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingTrackingLink;
};
