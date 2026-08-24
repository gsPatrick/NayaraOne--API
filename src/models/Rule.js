'use strict';

const { DataTypes } = require('sequelize');

/**
 * Rule — tabela "core"."rules"
 * Definição lógica de uma regra de negócio (cabeçalho); versão publicada é imutável.
 */
module.exports = (sequelize) => {
  const Rule = sequelize.define(
    'Rule',
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
      code: {
        type: DataTypes.STRING(128),
        allowNull: false,
        field: 'code',
        comment: "Identificador estável, ex. 'REG-FIN-001'",
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'name',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
      },
      domain: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'domain',
        comment: "Domínio de negócio ao qual a regra pertence",
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
      tableName: 'rules',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return Rule;
};
