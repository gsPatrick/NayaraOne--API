'use strict';

/**
 * Marco 9, demanda M9-D650 (KPIs de Obras no BI: progresso, baseline/actual/forecast e margem projetada): o read model rm_project_cost da M9-D618 passa a
 * guardar projected_margin = receita contratada menos o forecast do custo (nulo quando o forecast é nulo). É a coluna que o detalhe (drill-down) de
 * obra.projected_margin soma para bater com o KPI. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9725. Idempotente.
 * Faixa reservada: 9792 a 9799.
 */
const COLUMN = 'projected_margin numeric(18,2)';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_project_cost" ADD COLUMN IF NOT EXISTS ${COLUMN}`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_project_cost" DROP COLUMN IF EXISTS ${COLUMN.split(' ')[0]}`);
  },
};
