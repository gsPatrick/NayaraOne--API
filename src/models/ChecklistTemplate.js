'use strict';

const { DataTypes } = require('sequelize');

/**
 * ChecklistTemplate — tabela "construction"."checklist_templates" (migration 20260101006600). Item de checklist de
 * qualidade configurado por tipo de obra (projectTypeId; nulo = todos os tipos) e por etapa (stageCode; nulo = item da
 * obra). failureSeverity é a severidade da não conformidade que a reprovação do item abre (Caderno Obras §9).
 */
module.exports = (sequelize) =>
  sequelize.define(
    'ChecklistTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectTypeId: { type: DataTypes.UUID, allowNull: true, field: 'project_type_id' },
      stageCode: { type: DataTypes.STRING(40), allowNull: true, field: 'stage_code' },
      item: { type: DataTypes.STRING(255), allowNull: false, field: 'item' },
      category: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'OUTROS', field: 'category' },
      failureSeverity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'MEDIUM', field: 'failure_severity' },
      sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'sequence' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'active' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'checklist_templates',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );
