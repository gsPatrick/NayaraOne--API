'use strict';

const { DataTypes } = require('sequelize');

/**
 * MarginRule — tabela "construction"."margin_rules"
 * Versão vigente (ou histórica) da margem mínima exigida para aprovar orçamento de obra.
 * Ver DECISÃO DE ENGENHARIA no cabeçalho da migração 20260101000181 — cada linha é uma versão
 * imutável; o próprio `id` é o `rule_version_id` gravado em "construction"."budgets" no
 * momento da aprovação (M6-23/M6-61).
 */
module.exports = (sequelize) => {
  const MarginRule = sequelize.define(
    'MarginRule',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      minMarginPct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, field: 'min_margin_pct' },
      description: { type: DataTypes.STRING(255), allowNull: true, field: 'description' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'margin_rules',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return MarginRule;
};
