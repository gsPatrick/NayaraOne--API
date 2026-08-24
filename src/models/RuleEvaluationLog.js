'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleEvaluationLog — tabela "core"."rule_evaluation_log"
 * Log append-only de cada avaliação de regra em produção (observabilidade/auditoria).
 */
module.exports = (sequelize) => {
  const RuleEvaluationLog = sequelize.define(
    'RuleEvaluationLog',
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
      ruleVersionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'rule_version_id',
      },
      evaluatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'evaluated_at',
      },
      inputFactsJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'input_facts_json',
      },
      decision: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'decision',
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
      schema: 'core',
      tableName: 'rule_evaluation_log',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleEvaluationLog;
};
