'use strict';

const { DataTypes } = require('sequelize');

/** AiGoldenCase — tabela "ai"."golden_cases" (M9-D033): um caso do golden dataset de um agente da NAY, versionado e imutável por versão. */
module.exports = (sequelize) => sequelize.define(
  'AiGoldenCase',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: true, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: true, field: 'company_id' },
    agentCode: { type: DataTypes.STRING(64), allowNull: false, field: 'agent_code' },
    caseKey: { type: DataTypes.STRING(80), allowNull: false, field: 'case_key' },
    category: { type: DataTypes.STRING(16), allowNull: false, field: 'category' },
    input: { type: DataTypes.TEXT, allowNull: false, field: 'input' },
    fixtures: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'fixtures' },
    expected: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'expected' },
    mustNot: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'must_not' },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE', field: 'status' },
    sourceCandidateId: { type: DataTypes.UUID, allowNull: true, field: 'source_candidate_id' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    retiredBy: { type: DataTypes.UUID, allowNull: true, field: 'retired_by' },
    retiredAt: { type: DataTypes.DATE, allowNull: true, field: 'retired_at' },
  },
  { schema: 'ai', tableName: 'golden_cases', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
