'use strict';

/**
 * Migration: campos exigidos pelo "Banco de Dados Físico BLINDADO" (TAB-0751) que faltavam no
 * schema de movements — responsible_person_id (EST-006, responsável na saída de ferramenta) e
 * evidence_file_id (EST-008, ajuste exige evidência). E allow_negative_stock em items, porque a
 * regra do documento é condicional ("quando item não permitir estoque negativo"), não um
 * bloqueio incondicional — hoje o service bloqueia sempre, o que é mais estrito que o
 * documento exige; esta coluna permite a exceção sem afrouxar o padrão default.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'responsible_person_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'evidence_file_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'reason',
      { type: Sequelize.STRING(500), allowNull: true, comment: 'EST-008: motivo obrigatório para ADJUSTMENT/LOSS/DISPOSAL.' }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'allow_negative_stock',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inventory_items', schema: 'inventory' }, 'allow_negative_stock');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'reason');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'evidence_file_id');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'responsible_person_id');
  },
};
