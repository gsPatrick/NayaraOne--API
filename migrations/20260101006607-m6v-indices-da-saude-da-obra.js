'use strict';

/**
 * Esteira de qualidade do Marco 6 (achado M6Q-DEF-2): as tabelas de Obras que a Saúde da obra lê por obra (etapas, linhas de
 * orçamento, Change Orders, canteiros do Estoque) não tinham índice por project_id (só a chave primária e o company_id da RLS). Reversível.
 */
const INDICES = [
  ['construction.project_stages', 'project_stages_project_idx', '(project_id, sequence)'],
  ['construction.budget_lines', 'budget_lines_project_idx', '(project_id)'],
  ['construction.change_orders', 'change_orders_project_status_idx', '(project_id, status)'],
  // Custo de estoque consumido pela obra (inventoryCost.service): canteiros da obra.
  ['inventory.locations', 'locations_project_idx', '(project_id) WHERE project_id IS NOT NULL'],
];

module.exports = {
  async up(queryInterface) {
    for (const [tabela, nome, colunas] of INDICES) await queryInterface.sequelize.query(`CREATE INDEX IF NOT EXISTS ${nome} ON ${tabela} ${colunas}`);
  },
  async down(queryInterface) {
    for (const [tabela, nome] of INDICES) await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${tabela.split('.')[0]}.${nome}`);
  },
};
