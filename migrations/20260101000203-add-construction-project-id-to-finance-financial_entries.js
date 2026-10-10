'use strict';

/**
 * Migration: adiciona a dimensão `construction_project_id` a "finance"."financial_entries"
 * (M6-97). Nullable — só é preenchida quando o lançamento nasce de uma origem de Obras (hoje:
 * medição aprovada — stageMeasurements.service.js). Permite relatório de margem por obra
 * (juntar financial_entries.construction_project_id com construction.projects) sem precisar de
 * heurística sobre `description`/`contract_id`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'construction_project_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );

    await queryInterface.addIndex(
      { tableName: 'financial_entries', schema: 'finance' },
      ['construction_project_id'],
      { name: 'financial_entries_construction_project_id_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex(
      { tableName: 'financial_entries', schema: 'finance' },
      'financial_entries_construction_project_id_idx'
    );
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'construction_project_id');
  },
};
