'use strict';

/** Migration: cria "core"."role_permissions" — Associação N:N entre roles e permissions. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'role_permissions', schema: 'core' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        role_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'roles', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        permission_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'permissions', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'role_permissions', schema: 'core' });
  },
};
