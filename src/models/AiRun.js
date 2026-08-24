'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiRun — tabela "ai"."ai_runs"
 * Execução de um agente/tool da NAY — registro de auditoria de orquestração de IA.
 */
module.exports = (sequelize) => {
  const AiRun = sequelize.define(
    'AiRun',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'user_id',
        comment: "Usuário cujo escopo a NAY herdou",
      },
      agentName: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'agent_name',
        comment: "ex. NAY_ATENDIMENTO|NAY_COMERCIAL|NAY_FINANCEIRA",
      },
      inputSummary: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'input_summary',
      },
      toolCallsJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'tool_calls_json',
      },
      outputSummary: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'output_summary',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'COMPLETED',
        field: 'status',
      },
      costAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'cost_amount',
      },
      correlationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'correlation_id',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'ai',
      tableName: 'ai_runs',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AiRun;
};
