'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleVersion — tabela "core"."rule_versions"
 * Versão publicada e imutável de uma regra — nunca editada após publicação (rollback é nova publicação).
 */
module.exports = (sequelize) => {
  const RuleVersion = sequelize.define(
    'RuleVersion',
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
      ruleId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'rule_id',
      },
      versionNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'version_number',
      },
      conditionAstJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'condition_ast_json',
        comment: "AST tipado da condição (DSL segura declarativa)",
      },
      contentHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'content_hash',
      },
      actionJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'action_json',
      },
      effectiveFrom: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'effective_from',
      },
      effectiveUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'effective_until',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'DRAFT',
        field: 'status',
        comment: "DRAFT|SIMULATED|PUBLISHED|RETIRED",
      },
      publishedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'published_by_user_id',
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
      tableName: 'rule_versions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleVersion;
};
