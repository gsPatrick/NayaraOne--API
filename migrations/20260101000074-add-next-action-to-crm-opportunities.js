'use strict';

/**
 * Migration (EXPAND — 01_ARQUITETURA_E_INVARIANTES.md §2.11): adiciona "next_action" e
 * "next_action_due_at" a "crm"."opportunities" — Marco 3, regra de negócio "toda
 * opportunity ATIVA precisa ter próxima ação agendada" (04_MAPA_DE_MARCOS_E_CRITERIOS_DE_ACEITE.md).
 *
 * Ambas as colunas são NULLABLE a nível de schema (não quebram linhas existentes nem
 * qualquer INSERT/UPDATE feito fora da camada de aplicação, ex.: scripts administrativos
 * de correção). A obrigatoriedade de preenchimento quando `stage` não é um estágio
 * terminal (CLOSED_WON/CLOSED_LOST) é validada em src/features/crm/opportunities.service.js
 * antes do INSERT/UPDATE chegar ao banco — decisão documentada em
 * src/documentacao/features/Crm.md ("Por que não um CHECK constraint").
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'opportunities', schema: 'crm' },
      'next_action',
      {
        type: Sequelize.TEXT,
        allowNull: true,
      }
    );
    await queryInterface.addColumn(
      { tableName: 'opportunities', schema: 'crm' },
      'next_action_due_at',
      {
        type: Sequelize.DATE,
        allowNull: true,
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'opportunities', schema: 'crm' }, 'next_action_due_at');
    await queryInterface.removeColumn({ tableName: 'opportunities', schema: 'crm' }, 'next_action');
  },
};
