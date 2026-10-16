'use strict';

/**
 * Migration: Marco 8 Fase 4 (Eligibility) — adiciona `purpose` (finalidade do financiamento:
 * RESIDENCIAL|COMERCIAL) a `correspondent.financing_cases`. A regra COR_PROVIDER_ELIGIBILITY
 * (eligibility.service.js) usa esse campo, junto com o valor da simulação e o provider
 * configurado, para decidir elegibilidade — Caderno: "Antes de simular/submeter, chamar Motor
 * de Regras COR_PROVIDER_ELIGIBILITY com produto, finalidade, valor, imóvel/região e provider."
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'purpose',
      {
        type: Sequelize.STRING(24),
        allowNull: false,
        defaultValue: 'RESIDENCIAL',
        comment: 'Finalidade do financiamento: RESIDENCIAL|COMERCIAL. Usada pela regra COR_PROVIDER_ELIGIBILITY.',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'purpose');
  },
};
