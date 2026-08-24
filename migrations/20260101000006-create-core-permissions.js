'use strict';

/** Migration: cria "core"."permissions" — Permissão granular (catálogo global) referenciável por roles — ex. finance.entries.approve. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'permissions', schema: 'core' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        code: {
          type: Sequelize.STRING(128),
          allowNull: false,
          unique: true,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        risk_level: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'LOW',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'permissions', schema: 'core' });
  },
};
