'use strict';

const { DataTypes } = require('sequelize');

/** AiEvaluationItem — tabela "ai"."evaluation_items" (M9-D032): um caso avaliado; só entra, nunca muda. */
module.exports = (sequelize) => sequelize.define(
  'AiEvaluationItem',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    evaluationId: { type: DataTypes.UUID, allowNull: false, field: 'evaluation_id' },
    caseId: { type: DataTypes.STRING(120), allowNull: false, field: 'case_id' },
    category: { type: DataTypes.STRING(16), allowNull: false, field: 'category' },
    inputHash: { type: DataTypes.STRING(64), allowNull: false, field: 'input_hash' },
    expected: { type: DataTypes.TEXT, allowNull: true, field: 'expected' },
    actualSummary: { type: DataTypes.TEXT, allowNull: true, field: 'actual_summary' },
    passed: { type: DataTypes.BOOLEAN, allowNull: false, field: 'passed' },
    score: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: 0, field: 'score' },
    latencyMs: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_ms' },
    costAmount: { type: DataTypes.DECIMAL(14, 6), allowNull: false, defaultValue: 0, field: 'cost_amount' },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'details' },
  },
  { schema: 'ai', tableName: 'evaluation_items', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
