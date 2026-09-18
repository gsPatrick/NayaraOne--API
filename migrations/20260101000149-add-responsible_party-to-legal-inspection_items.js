'use strict';

/**
 * Migration: adiciona "legal"."inspection_items"."responsible_party" (M5-21).
 *
 * Sem esse campo, a vistoria dizia QUAL era o dano e QUANTO custa consertar, mas não DE QUEM
 * é a responsabilidade — o que decide se o valor é descontado da caução do locatário, é ônus
 * do locador, ou é rateado. Nullable no banco (itens antigos e itens não-danificados não têm
 * responsável), mas OBRIGATÓRIO na aplicação quando condition = 'DAMAGED', mesma regra já
 * aplicada a damage_description/estimated_budget.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inspection_items', schema: 'legal' },
      'responsible_party',
      {
        type: Sequelize.STRING(16),
        allowNull: true,
        comment: 'TENANT|LANDLORD|SHARED|UNDETERMINED — obrigatório quando condition = DAMAGED',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inspection_items', schema: 'legal' }, 'responsible_party');
  },
};
