'use strict';

const { DataTypes } = require('sequelize');

/** AiEvaluation — tabela "ai"."evaluations" (M9-D032): uma execução da bateria de avaliação de uma versão de agente da NAY. */
module.exports = (sequelize) => sequelize.define(
  'AiEvaluation',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    agentCode: { type: DataTypes.STRING(64), allowNull: false, field: 'agent_code' },
    agentVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'agent_version' },
    providerCode: { type: DataTypes.STRING(60), allowNull: true, field: 'provider_code' },
    modelCode: { type: DataTypes.STRING(120), allowNull: true, field: 'model_code' },
    suite: { type: DataTypes.STRING(12), allowNull: false, field: 'suite' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'QUEUED', field: 'status' },
    startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
    finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    totals: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'totals' },
    metrics: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'metrics' },
    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: 'error_code' },
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
    triggeredBy: { type: DataTypes.UUID, allowNull: true, field: 'triggered_by' },
    homologatedBy: { type: DataTypes.UUID, allowNull: true, field: 'homologated_by' },
    homologatedAt: { type: DataTypes.DATE, allowNull: true, field: 'homologated_at' },
    homologationNote: { type: DataTypes.TEXT, allowNull: true, field: 'homologation_note' },
  },
  { schema: 'ai', tableName: 'evaluations', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
