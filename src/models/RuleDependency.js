'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleDependency — tabela "core"."rule_dependencies"
 * Dependência explícita entre regras (grafo de dependências).
 */
module.exports = (sequelize) => {
  const RuleDependency = sequelize.define(
    'RuleDependency',
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
        comment: "Regra dependente",
      },
      dependsOnRuleId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'depends_on_rule_id',
        comment: "Regra da qual depende",
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
      tableName: 'rule_dependencies',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleDependency;
};
