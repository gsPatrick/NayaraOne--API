'use strict';

/**
 * Migration (M4-13): adiciona "finance"."reconciliations"."match_group_id".
 *
 * Conciliação N:N. A modelagem reaproveita a tabela `reconciliations` existente (1 linha =
 * 1 par lançamento↔transação) e amarra todas as linhas de um mesmo casamento em grupo por um
 * `match_group_id` compartilhado (UUID gerado no ato). Assim nada do 1:1 existente quebra
 * (match_group_id fica NULL nas conciliações simples) e o grupo inteiro continua consultável
 * por uma única coluna.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'reconciliations', schema: 'finance' },
      'match_group_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addIndex(
      { tableName: 'reconciliations', schema: 'finance' },
      ['match_group_id'],
      { name: 'reconciliations_match_group_id_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex({ tableName: 'reconciliations', schema: 'finance' }, 'reconciliations_match_group_id_idx');
    await queryInterface.removeColumn({ tableName: 'reconciliations', schema: 'finance' }, 'match_group_id');
  },
};
