'use strict';

const { DataTypes } = require('sequelize');

/**
 * RuleScope — tabela "core"."rule_scopes"
 * Escopo de aplicação de uma versão de regra na hierarquia de precedência (objeto/usuário/unidade/depto/empresa/grupo/global).
 */
module.exports = (sequelize) => {
  const RuleScope = sequelize.define(
    'RuleScope',
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
      scopeType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'scope_type',
        comment: "OBJECT|USER|UNIT|DEPARTMENT|COMPANY|GROUP|GLOBAL",
      },
      scopeRefId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'scope_ref_id',
      },
      precedence: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 7,
        field: 'precedence',
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
      tableName: 'rule_scopes',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RuleScope;
};
