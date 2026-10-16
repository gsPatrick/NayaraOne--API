'use strict';

/**
 * Migration: adiciona `unit_id` (nullable, FK -> core.units) em "construction"."projects" —
 * M6-95. Segue o mesmo padrão de group_id/company_id já usado no projeto e o mesmo tipo/nome
 * de coluna usado em core.user_memberships (migrations/20260101000004) — relacionamento raiz
 * group -> company -> unit; obra aponta para unit_id quando a obra pertence a uma unidade
 * específica dentro da empresa (nullable porque nem toda empresa opera com unidades).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'projects', schema: 'construction' },
      'unit_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'units', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'projects', schema: 'construction' }, 'unit_id');
  },
};
