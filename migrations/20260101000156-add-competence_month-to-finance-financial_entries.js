'use strict';

/**
 * Migration (M4-03): adiciona "finance"."financial_entries"."competence_month".
 *
 * Vencimento (`due_at`) e COMPETÊNCIA (mês contábil a que o lançamento pertence) são coisas
 * diferentes — ex.: conta de energia do consumo de setembro que vence em outubro. Até aqui só
 * existia `due_at`, o que impedia qualquer relatório por regime de competência.
 * Formato "YYYY-MM" (STRING(7)), nullable — quando não informado, o service deriva
 * (ver financialEntries.service.js: due_at -> senão data de criação).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'competence_month',
      { type: Sequelize.STRING(7), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'competence_month');
  },
};
