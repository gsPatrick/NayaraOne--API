'use strict';

const { DataTypes } = require('sequelize');

/**
 * Notification — tabela "core"."notifications"
 * Notificação in-app/e-mail direcionada a um usuário.
 */
module.exports = (sequelize) => {
  const Notification = sequelize.define(
    'Notification',
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
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      channel: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'IN_APP',
        field: 'channel',
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'title',
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'body',
      },
      readAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'read_at',
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
      tableName: 'notifications',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return Notification;
};
