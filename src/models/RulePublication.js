'use strict';

const { DataTypes } = require('sequelize');

/**
 * RulePublication — tabela "core"."rule_publications"
 * Registro imutável de cada publicação efetiva de uma versão de regra.
 */
module.exports = (sequelize) => {
  const RulePublication = sequelize.define(
    'RulePublication',
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
      publishedByUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'published_by_user_id',
      },
      publishedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'published_at',
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
      tableName: 'rule_publications',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return RulePublication;
};
