'use strict';

/**
 * Migration: EST-004 exige projectId em todo movimento tocando local PROJECT_SITE — loss_cases
 * e counts podem ocorrer num canteiro e precisam guardar o projectId pra propagar no
 * LOSS/ADJUSTMENT gerado na decisão/ajuste (sem isso, decidir um loss_case ou aplicar um
 * ajuste de contagem num canteiro quebraria com INVENTORY_MOVEMENT_PROJECT_REQUIRED).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'loss_cases', schema: 'inventory' },
      'project_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'counts', schema: 'inventory' },
      'project_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'counts', schema: 'inventory' }, 'project_id');
    await queryInterface.removeColumn({ tableName: 'loss_cases', schema: 'inventory' }, 'project_id');
  },
};
