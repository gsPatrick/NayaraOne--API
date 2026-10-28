'use strict';

const { DataTypes } = require('sequelize');

/** AiAgentTool — tabela "ai"."agent_tools" (M9-D004): allowlist de tools de uma versão de agente (só muda com o agente em DRAFT). */
module.exports = (sequelize) => sequelize.define(
  'AiAgentTool',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: true, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: true, field: 'company_id' },
    agentId: { type: DataTypes.UUID, allowNull: false, field: 'agent_id' },
    toolName: { type: DataTypes.STRING(100), allowNull: false, field: 'tool_name' },
    permissionCode: { type: DataTypes.STRING(100), allowNull: false, field: 'permission_code' },
    riskLevel: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'LOW', field: 'risk_level' },
    requiresHumanApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'requires_human_approval' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'ai', tableName: 'agent_tools', timestamps: true, underscored: true }
);
