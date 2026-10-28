'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingAttributionEvent — tabela "marketing"."attribution_events".
 * Evento de atribuição (M9-D401): clique, lead, visita, proposta ou venda, com papéis de toque FIRST/LAST e evidência.
 */
module.exports = (sequelize) => {
  const MarketingAttributionEvent = sequelize.define(
    'MarketingAttributionEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      personId: { type: DataTypes.UUID, allowNull: true, field: 'person_id' },
      opportunityId: { type: DataTypes.UUID, allowNull: true, field: 'opportunity_id' },
      campaignId: { type: DataTypes.UUID, allowNull: true, field: 'campaign_id' },
      trackingLinkId: { type: DataTypes.UUID, allowNull: true, field: 'tracking_link_id' },
      eventType: { type: DataTypes.STRING(16), allowNull: false, field: 'event_type' },
      touchRoles: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [], field: 'touch_roles' },
      evidenceJson: { type: DataTypes.JSONB, allowNull: false, field: 'evidence_json' },
      valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'valid' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'attribution_events',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingAttributionEvent;
};
