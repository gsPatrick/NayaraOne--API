'use strict';

/**
 * Migration: adiciona `construction_project_id` (nullable, FK -> construction.projects) em
 * "legal"."contracts" — M6-104 (dependência cruzada Marco 5 <-> Marco 6).
 *
 * Vincula um contrato do tipo CONSTRUCTION (empreitada) à obra correspondente. Nullable porque
 * só é obrigatório quando contract_type = 'CONSTRUCTION' (validado em código, não em CHECK
 * constraint de banco — mesmo padrão usado para os outros campos condicionais desse módulo).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'contracts', schema: 'legal' },
      'construction_project_id',
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
    await queryInterface.removeColumn({ tableName: 'contracts', schema: 'legal' }, 'construction_project_id');
  },
};
