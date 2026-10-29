'use strict';

const { DataTypes } = require('sequelize');

/** AiGoldenCandidate — tabela "ai"."golden_candidates" (M9-D032): caso sugerido por um feedback negativo; só entra no dataset se uma pessoa aprovar. */
module.exports = (sequelize) => sequelize.define(
  'AiGoldenCandidate',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    feedbackId: { type: DataTypes.UUID, allowNull: false, field: 'feedback_id' },
    runId: { type: DataTypes.UUID, allowNull: false, field: 'run_id' },
    agentCode: { type: DataTypes.STRING(64), allowNull: true, field: 'agent_code' },
    category: { type: DataTypes.STRING(40), allowNull: true, field: 'category' },
    comment: { type: DataTypes.STRING(500), allowNull: true, field: 'comment' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING', field: 'status' },
    decidedBy: { type: DataTypes.UUID, allowNull: true, field: 'decided_by' },
    decidedAt: { type: DataTypes.DATE, allowNull: true, field: 'decided_at' },
    decisionNote: { type: DataTypes.STRING(500), allowNull: true, field: 'decision_note' },
  },
  { schema: 'ai', tableName: 'golden_candidates', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
