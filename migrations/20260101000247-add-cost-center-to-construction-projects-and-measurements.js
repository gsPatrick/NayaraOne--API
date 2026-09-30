'use strict';

/**
 * M6-97 (reforço, achado numa nova rodada de verificação de integrações — 30/09/2026): a fonte
 * (Centro Financeiro BLINDADO — "4. Plano de contas e dimensões") exige "Centro de custo
 * obrigatório para despesa" como regra transversal do Financeiro, além de listar "Projeto/obra"
 * como dimensão. O lançamento financeiro que a medição aprovada gera (M6-85) é uma despesa
 * (nature=PAYABLE) e não carregava `cost_center_id` nenhum — só `construction_project_id`.
 * Adiciona `cost_center_id` em `construction.projects` (centro de custo padrão da obra) e em
 * `construction.stage_measurements` (override pontual por medição, quando a obra tiver mais de
 * um centro de custo em uso) — ambos nullable, FK para `finance.cost_centers`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'projects', schema: 'construction' },
      'cost_center_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'cost_center_id',
      { type: Sequelize.UUID, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'cost_center_id');
    await queryInterface.removeColumn({ tableName: 'projects', schema: 'construction' }, 'cost_center_id');
  },
};
