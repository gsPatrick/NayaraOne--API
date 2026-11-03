'use strict';

/**
 * BUG REAL CORRIGIDO (30/09/2026, achado numa nova rodada de verificação de integrações do
 * Marco 6): a fonte lista "equipe, serviços, fotos, materiais, ocorrências e bloqueios" como
 * conceitos DISTINTOS que o diário registra. "serviços" (o que foi executado no dia) estava
 * sendo confundido/embutido no campo `occurrences` (que deveria cobrir só ocorrências e
 * bloqueios) — campo próprio ausente. Adiciona `services_performed` (TEXT, nullable).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'services_performed',
      { type: Sequelize.TEXT, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'services_performed');
  },
};
