'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleTestCase — tabela "core"."rule_test_cases"
 * Caso de teste obrigatório associado a uma regra (executado antes da publicação).
 */
module.exports = (sequelize) => {
  const RuleTestCase = sequelize.define(
    'RuleTestCase',
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
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      inputFactsJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'input_facts_json',
      },
      expectedOutputJson: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'expected_output_json',
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
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'core',
      tableName: 'rule_test_cases',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return RuleTestCase;
};
