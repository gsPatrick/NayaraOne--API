'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProjectType — tabela "construction"."project_types" (migration 20260101006600). Tipo de obra cadastrado pelo
 * administrador da empresa; o checklist de qualidade é montado por tipo de obra e por etapa (Caderno Obras §9).
 */
module.exports = (sequelize) =>
  sequelize.define(
    'ProjectType',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      code: { type: DataTypes.STRING(40), allowNull: false, field: 'code' },
      name: { type: DataTypes.STRING(120), allowNull: false, field: 'name' },
      description: { type: DataTypes.TEXT, allowNull: true, field: 'description' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'active' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'project_types',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );
