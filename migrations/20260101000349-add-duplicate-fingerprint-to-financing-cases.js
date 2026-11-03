'use strict';

/**
 * Migration: Marco 8 Fase 11 (Segurança/antifraude) — "Caso duplicado → fingerprint + fila de
 * revisão (não bloqueio automático silencioso)". Adiciona `duplicate_fingerprint` (hash
 * determinístico de companyId+personId principal+propertyId+janela de data, calculado em
 * código) e `possible_duplicate_of_case_id` (nullable, auto-referência — só sinalização, nunca
 * bloqueia a criação) a `correspondent.financing_cases`. Mesmo espírito do dedupe de pessoas do
 * Marco 3 (personDedup.service.js): "abre revisão; não mescla/bloqueia automaticamente".
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'duplicate_fingerprint',
      {
        type: Sequelize.STRING(64),
        allowNull: true,
        comment: 'Hash determinístico (companyId+personId principal+propertyId+dia) usado só para sinalizar possível duplicata — nunca bloqueia criação.',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'possible_duplicate_of_case_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        comment: 'Aponta para outro financing_case com o mesmo fingerprint, criado dentro da mesma janela — sinalização para revisão humana, nunca bloqueio.',
      }
    );
    await queryInterface.addIndex(
      { tableName: 'financing_cases', schema: 'correspondent' },
      ['company_id', 'duplicate_fingerprint'],
      { name: 'financing_cases_duplicate_fingerprint_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'financing_cases_duplicate_fingerprint_idx'
    );
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'possible_duplicate_of_case_id');
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'duplicate_fingerprint');
  },
};
