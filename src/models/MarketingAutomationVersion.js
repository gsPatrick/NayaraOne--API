'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarketingAutomationVersion — tabela "marketing"."automation_versions".
 * Versão de um fluxo de automação (M9-D401). Fora de DRAFT é imutável (MK003).
 */
module.exports = (sequelize) => {
  const MarketingAutomationVersion = sequelize.define(
    'MarketingAutomationVersion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      flowId: { type: DataTypes.UUID, allowNull: false, field: 'flow_id' },
      versionNo: { type: DataTypes.INTEGER, allowNull: false, field: 'version_no' },
      triggerType: { type: DataTypes.STRING(8), allowNull: false, field: 'trigger_type' },
      triggerConfig: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'trigger_config' },
      conditions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'conditions' },
      actions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'actions' },
      cooldown: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'cooldown' },
      frequencyCap: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'frequency_cap' },
      validFrom: { type: DataTypes.DATE, allowNull: true, field: 'valid_from' },
      validUntil: { type: DataTypes.DATE, allowNull: true, field: 'valid_until' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT', field: 'status' },
      riskLevel: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'LOW', field: 'risk_level' },
      contentHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'content_hash' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'marketing',
      tableName: 'automation_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return MarketingAutomationVersion;
};
