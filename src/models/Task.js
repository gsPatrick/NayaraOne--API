'use strict';

const { DataTypes } = require('sequelize');

/**
 * Task — tabela "core"."tasks"
 * Tarefa/atividade operacional atribuível a um usuário, ligada a qualquer entidade do sistema.
 */
module.exports = (sequelize) => {
  const Task = sequelize.define(
    'Task',
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
      assignedToUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'assigned_to_user_id',
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'title',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
      },
      relatedEntityType: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'related_entity_type',
        comment: "Tipo da entidade relacionada (polimórfico), ex. legal.contracts",
      },
      relatedEntityId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'related_entity_id',
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'due_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPEN',
        field: 'status',
      },
      priority: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'NORMAL',
        field: 'priority',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
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
      tableName: 'tasks',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Task;
};
