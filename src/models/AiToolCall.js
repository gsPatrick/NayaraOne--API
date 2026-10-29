'use strict';

const { DataTypes } = require('sequelize');

/**
 * AiToolCall — tabela "ai"."tool_calls" (M9-D006)
 * Tentativa de ferramenta da NAY: argumentos sanitizados, hash, estado, resultado curto e idempotência.
 */
module.exports = (sequelize) => {
  const AiToolCall = sequelize.define(
    'AiToolCall',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      runId: { type: DataTypes.UUID, allowNull: false, field: 'run_id' },
      seq: { type: DataTypes.INTEGER, allowNull: false, field: 'seq' },
      toolName: { type: DataTypes.STRING(100), allowNull: false, field: 'tool_name' },
      toolVersion: { type: DataTypes.STRING(40), allowNull: true, field: 'tool_version' },
      permissionCode: { type: DataTypes.STRING(100), allowNull: true, field: 'permission_code' },
      riskLevel: { type: DataTypes.STRING(10), allowNull: true, field: 'risk_level' },
      argsSanitized: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'args_sanitized' },
      argsHash: { type: DataTypes.STRING(64), allowNull: false, field: 'args_hash' },
      idempotencyKey: { type: DataTypes.STRING(300), allowNull: false, field: 'idempotency_key' },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'REQUESTED', field: 'status' },
      blockedReason: { type: DataTypes.STRING(80), allowNull: true, field: 'blocked_reason' },
      resultSummary: { type: DataTypes.JSONB, allowNull: true, field: 'result_summary' },
      resultHash: { type: DataTypes.STRING(64), allowNull: true, field: 'result_hash' },
      latencyMs: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_ms' },
      proposalId: { type: DataTypes.UUID, allowNull: true, field: 'proposal_id' },
      startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
      contentPurgedAt: { type: DataTypes.DATE, allowNull: true, field: 'content_purged_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { schema: 'ai', tableName: 'tool_calls', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
  );

  return AiToolCall;
};
