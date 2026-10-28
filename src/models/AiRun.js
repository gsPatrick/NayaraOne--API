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
        type: DataTypes.DECIMAL(18, 6),
        allowNull: true,
        field: 'cost_amount',
        comment: "custo em BRL com seis casas (M9-D005); a soma usa NUMERIC, nunca ponto flutuante",
      },
      correlationId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'correlation_id',
      },
      agentId: { type: DataTypes.UUID, allowNull: true, field: 'agent_id' },
      agentVersion: { type: DataTypes.INTEGER, allowNull: true, field: 'agent_version' },
      purpose: { type: DataTypes.STRING(200), allowNull: true, field: 'purpose' },
      providerCode: { type: DataTypes.STRING(60), allowNull: true, field: 'provider_code' },
      modelCode: { type: DataTypes.STRING(120), allowNull: true, field: 'model_code' },
      routingPath: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'RULE', field: 'routing_path', comment: 'RULE|SMALL_MODEL|ADVANCED_MODEL|CACHE' },
      tokensIn: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'tokens_in' },
      tokensOut: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'tokens_out' },
      costCurrency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'BRL', field: 'cost_currency' },
      latencyMs: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_ms' },
      groundingStatus: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'NOT_APPLICABLE', field: 'grounding_status' },
      confidence: { type: DataTypes.DECIMAL(4, 3), allowNull: true, field: 'confidence', comment: 'sinal auxiliar de 0 a 1, nunca critério de aprovação' },
      blockedReason: { type: DataTypes.STRING(120), allowNull: true, field: 'blocked_reason' },
      errorCode: { type: DataTypes.STRING(80), allowNull: true, field: 'error_code' },
      idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
      parentRunId: { type: DataTypes.UUID, allowNull: true, field: 'parent_run_id' },
      startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
      snapshotAt: { type: DataTypes.DATE, allowNull: true, field: 'snapshot_at', comment: 'instante do dado usado' },
      requestHash: { type: DataTypes.STRING(64), allowNull: true, field: 'request_hash' },
      contentPurgedAt: { type: DataTypes.DATE, allowNull: true, field: 'content_purged_at' },
      fallbackTrail: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'fallback_trail', comment: 'saltos {from,to,reason} (M9-D013)' },
      escalated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'escalated', comment: 'M9-D012' },
      cached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'cached', comment: 'M9-D015' },
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
