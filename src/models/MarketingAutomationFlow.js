'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingAutomationFlow — tabela "marketing"."automation_flows".
 * Fluxo de automação (M9-D401), com dono e kill switch.
 */
module.exports = (sequelize) => {
  const MarketingAutomationFlow = sequelize.define(
    'MarketingAutomationFlow',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(80), allowNull: false, field: 'code' },
      name: { type: DataTypes.STRING(200), allowNull: false, field: 'name' },
      ownerUserId: { type: DataTypes.UUID, allowNull: false, field: 'owner_user_id' },
      riskLevel: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'LOW', field: 'risk_level' },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
      publishedVersionId: { type: DataTypes.UUID, allowNull: true, field: 'published_version_id' },
      killSwitchActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'kill_switch_active' },
      killSwitchAt: { type: DataTypes.DATE, allowNull: true, field: 'kill_switch_at' },
      killSwitchBy: { type: DataTypes.UUID, allowNull: true, field: 'kill_switch_by' },
      killSwitchReason: { type: DataTypes.TEXT, allowNull: true, field: 'kill_switch_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'automation_flows',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingAutomationFlow;
};
