'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingCampaignStep — tabela "marketing"."campaign_steps".
 * Etapa da campanha (M9-D400): canal, template e deslocamento em minutos a partir do início.
 */
module.exports = (sequelize) => {
  const MarketingCampaignStep = sequelize.define(
    'MarketingCampaignStep',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      campaignId: { type: DataTypes.UUID, allowNull: false, field: 'campaign_id' },
      stepNo: { type: DataTypes.INTEGER, allowNull: false, field: 'step_no' },
      channel: { type: DataTypes.STRING(16), allowNull: false },
      templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
      contentItemId: { type: DataTypes.UUID, allowNull: true, field: 'content_item_id' },
      offsetMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'offset_minutes' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PLANNED' },
      statusReason: { type: DataTypes.STRING(60), allowNull: true, field: 'status_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'campaign_steps',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingCampaignStep;
};
