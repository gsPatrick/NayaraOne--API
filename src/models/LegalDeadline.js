'use strict';

const { DataTypes } = require('sequelize');

/**
 * LegalDeadline — tabela "legal"."legal_deadlines"
 * Prazo processual/contratual crítico vinculado a um caso jurídico.
 */
module.exports = (sequelize) => {
  const LegalDeadline = sequelize.define(
    'LegalDeadline',
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
      legalCaseId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'legal_case_id',
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'description',
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'due_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
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
      tableName: 'legal_deadlines',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return LegalDeadline;
};
