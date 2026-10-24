'use strict';

/**
 * Migration: TAB-0750 ("Banco de Dados Físico BLINDADO") exige "status" ACTIVE/INACTIVE em
 * inventory_items — faltava por completo. Sem isso não existe forma de retirar um item do
 * catálogo (descontinuar) sem apagá-lo, o que violaria o histórico de movimentos/recebimentos
 * já vinculados a ele (FK RESTRICT em todas as tabelas que referenciam inventory_item_id).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'status',
      { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'ACTIVE', comment: 'ACTIVE|INACTIVE' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inventory_items', schema: 'inventory' }, 'status');
  },
};
