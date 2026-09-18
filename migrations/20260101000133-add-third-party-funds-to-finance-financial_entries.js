'use strict';

/**
 * Migration: adiciona "finance"."financial_entries"."is_third_party_funds" e
 * "third_party_reference" (M4-16 — segregação contábil de caução/dinheiro de terceiros).
 *
 * Caução, depósito de garantia e valores de locatário/proprietário que apenas TRANSITAM pela
 * imobiliária não são receita própria: contabilizá-los junto com a receita infla o resultado e
 * mistura patrimônio de terceiros com o da empresa. Sem essa marcação não havia como separar
 * os dois grupos em nenhum relatório.
 *
 * Default false + NOT NULL: todo lançamento pré-existente é, por definição, dinheiro próprio
 * (nenhum deles foi criado com intenção de segregação), então o backfill implícito do default
 * é semanticamente correto e não reescreve histórico de valor (FIN-003).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'is_third_party_funds',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'third_party_reference',
      {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Identificação do titular/origem do dinheiro de terceiro (ex.: "Caução contrato X")',
      }
    );
    await queryInterface.addIndex(
      { tableName: 'financial_entries', schema: 'finance' },
      ['is_third_party_funds'],
      { name: 'financial_entries_third_party_funds_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex({ tableName: 'financial_entries', schema: 'finance' }, 'financial_entries_third_party_funds_idx');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'third_party_reference');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'is_third_party_funds');
  },
};
