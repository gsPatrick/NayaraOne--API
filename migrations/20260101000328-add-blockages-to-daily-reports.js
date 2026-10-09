'use strict';

/**
 * GAP REAL CORRIGIDO ("ciclos até secar", Ciclo 8, Frente B — comparação literal com o
 * Caderno Técnico, 2026-10-09): a fonte (seção 6, "Diário e equipes") exige que o RDO registre
 * "ocorrências e bloqueios" como dois itens distintos. Uma correção anterior adicionou o campo
 * `occurrences`, mas não o campo `blockages` que a mesma frase da fonte também exige — sem
 * campo próprio, "bloqueios" (paralisação por chuva, falta de material, pendência de
 * terceiros) ficava forçado dentro do texto livre de occurrences, impedindo qualquer KPI/
 * dashboard futuro de distinguir e contar bloqueios estruturadamente.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'blockages',
      { type: Sequelize.TEXT, allowNull: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'blockages');
  },
};
