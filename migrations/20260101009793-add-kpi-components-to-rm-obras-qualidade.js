'use strict';

/**
 * Marco 9, demanda M9-D651 (KPIs de Obras no BI: atrasos, medições e não conformidades): os read models de Obras da M9-D618 passam a guardar dois
 * componentes que o KPI pede e a fonte reproduz, sem voltar ao OLTP a cada leitura.
 *  - rm_project_nonconformities.opened_30d: não conformidades abertas (criadas) nos últimos 30 dias, mesma janela das fechadas ("abertas no período").
 *  - rm_project_measurements.approved_without_payment: medições aprovadas sem lançamento de pagamento previsto (regra de qualidade do KPI).
 * Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9725. Idempotente. Faixa reservada: 9792 a 9799.
 */
const COLUMNS = [
  ['rm_project_nonconformities', 'opened_30d integer NOT NULL DEFAULT 0 CHECK (opened_30d >= 0)'],
  ['rm_project_measurements', 'approved_without_payment integer NOT NULL DEFAULT 0 CHECK (approved_without_payment >= 0)'],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
