'use strict';

/**
 * Migration (M4-06): adiciona "finance"."financial_entries"."parent_entry_id".
 *
 * Liquidação PARCIAL no ledger. O ledger é imutável (FIN-003/FIN-010): o `amount` do
 * lançamento original NUNCA é alterado. Cada baixa parcial vira um NOVO lançamento SETTLED
 * com o valor parcial, apontando para o original via `parent_entry_id`. O saldo restante é
 * CALCULADO (amount do pai - soma dos filhos), não armazenado — evita qualquer chance de
 * divergência entre um saldo materializado e o próprio ledger.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'parent_entry_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addIndex(
      { tableName: 'financial_entries', schema: 'finance' },
      ['parent_entry_id'],
      { name: 'financial_entries_parent_entry_id_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex({ tableName: 'financial_entries', schema: 'finance' }, 'financial_entries_parent_entry_id_idx');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'parent_entry_id');
  },
};
