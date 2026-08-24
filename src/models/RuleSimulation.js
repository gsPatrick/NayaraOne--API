'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleSimulation — tabela "core"."rule_simulations"
 * Simulação obrigatória de uma versão de regra antes da publicação, com resultado.
 */
module.exports = (sequelize) => {
  const RuleSimulation = sequelize.define(
    'RuleSimulation',
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
      requestedByUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'requested_by_user_id',
      },
      inputFactsJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'input_facts_json',
      },
      outputJson: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'output_json',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
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
      tableName: 'rule_simulations',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleSimulation;
};
