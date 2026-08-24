'use strict';

const { DataTypes } = require('sequelize');

/**
 * InspectionItem — tabela "legal"."inspection_items"
 * Item/ambiente avaliado dentro de uma vistoria, com condição registrada.
 */
module.exports = (sequelize) => {
  const InspectionItem = sequelize.define(
    'InspectionItem',
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
      inspectionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'inspection_id',
      },
      itemName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'item_name',
      },
      condition: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'condition',
        comment: "GOOD|REGULAR|DAMAGED",
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'notes',
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
      schema: 'legal',
      tableName: 'inspection_items',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return InspectionItem;
};
