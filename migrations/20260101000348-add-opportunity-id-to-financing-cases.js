'use strict';

/**
 * Migration: Marco 8 Fase 9 (Eventos de domínio) — adiciona `opportunity_id` (nullable) a
 * `correspondent.financing_cases`. Mesmo padrão de referência já usado por
 * `legal.contracts.opportunity_id` (só referência, sem FK dura entre schemas) — quando
 * preenchido, o Caderno exige que "status relevantes do financing_case atualizam a oportunidade
 * do CRM via eventos (nunca escrita direta)" (ver correspondentCrmSync.service.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'opportunity_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        comment: 'Oportunidade de CRM vinculada (opcional) — atualizada só via evento/audit log, nunca escrita direta no registro da oportunidade.',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'opportunity_id');
  },
};
