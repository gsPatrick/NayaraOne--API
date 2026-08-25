'use strict';

const { DataTypes } = require('sequelize');

/**
 * QualityChecklistItem — tabela "construction"."quality_checklist_items"
 * Item de checklist de qualidade de uma obra (opcionalmente vinculado a uma etapa).
 */
module.exports = (sequelize) => {
  const QualityChecklistItem = sequelize.define(
    'QualityChecklistItem',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      projectId: { type: DataTypes.UUID, allowNull: false, field: 'project_id' },
      projectStageId: { type: DataTypes.UUID, allowNull: true, field: 'project_stage_id' },
      item: { type: DataTypes.STRING(255), allowNull: false, field: 'item' },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: 'PENDING|OK|NOT_OK',
      },
      checkedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'checked_by_user_id' },
      checkedAt: { type: DataTypes.DATE, allowNull: true, field: 'checked_at' },
      notes: { type: DataTypes.TEXT, allowNull: true, field: 'notes' },
      lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'lock_version' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
      deletedBy: { type: DataTypes.UUID, allowNull: true, field: 'deleted_by' },
    },
    {
      schema: 'construction',
      tableName: 'quality_checklist_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return QualityChecklistItem;
};
