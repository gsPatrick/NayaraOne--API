'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingCampaign — tabela "marketing"."campaigns".
 * Campanha de marketing (M9-D400). Estados DRAFT, SCHEDULED, RUNNING, ENDED; pausa é o kill switch da campanha.
 */
module.exports = (sequelize) => {
  const MarketingCampaign = sequelize.define(
    'MarketingCampaign',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(60), allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false },
      objective: { type: DataTypes.TEXT, allowNull: false },
      objectiveMetric: { type: DataTypes.STRING(16), allowNull: false, field: 'objective_metric' },
      targetValue: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'target_value' },
      budgetAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'budget_amount' },
      budgetJustification: { type: DataTypes.TEXT, allowNull: true, field: 'budget_justification' },
      costActual: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0, field: 'cost_actual' },
      channels: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT' },
      resultValue: { type: DataTypes.DECIMAL(14, 2), allowNull: true, field: 'result_value' },
      startsAt: { type: DataTypes.DATE, allowNull: true, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      ownerUserId: { type: DataTypes.UUID, allowNull: false, field: 'owner_user_id' },
      killSwitchActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'kill_switch_active' },
      killSwitchAt: { type: DataTypes.DATE, allowNull: true, field: 'kill_switch_at' },
      killSwitchBy: { type: DataTypes.UUID, allowNull: true, field: 'kill_switch_by' },
      killSwitchReason: { type: DataTypes.TEXT, allowNull: true, field: 'kill_switch_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'campaigns',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingCampaign;
};
