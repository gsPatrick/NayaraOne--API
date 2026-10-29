'use strict';

/**
 * Marco 9, demanda M9-D633 (KPIs de Radar, captação e conversão por corretor no BI): campos ADITIVOS nos read models da M9-D616, só agregados e ids
 * (nenhum nome nem documento). Nenhuma chave muda e nenhuma coluna existente é tocada: o RLS e os GRANTs da M9-D616 continuam valendo.
 *  - rm_radar_matches: cruzamentos já avisados, cruzamentos que geraram visita ou oportunidade, cruzamentos sem perfil ou sem imóvel ativo, por origem do
 *    perfil e por corretor do perfil.
 *  - rm_broker_performance: oportunidades perdidas no mês, valor pedido e quantidade com valor dos imóveis captados.
 * Idempotente. Faixa reservada: 9784 a 9791.
 */
const COUNT = (name) => `ADD COLUMN IF NOT EXISTS "${name}" integer NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const JSONB = (name) => `ADD COLUMN IF NOT EXISTS "${name}" jsonb NOT NULL DEFAULT '{}'::jsonb`;
const MONEY = (name) => `ADD COLUMN IF NOT EXISTS "${name}" numeric(18,2) NOT NULL DEFAULT 0`;

const ALTERS = {
  rm_radar_matches: [COUNT('sent'), COUNT('invalid'), COUNT('converted_visit_opp'), JSONB('by_origin'), JSONB('by_broker')],
  rm_broker_performance: [COUNT('lost'), COUNT('captured_with_value'), MONEY('captured_value_sum')],
};

module.exports = {
  up: async (queryInterface) => {
    for (const [table, columns] of Object.entries(ALTERS)) {
      await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ${columns.join(', ')}`);
    }
  },

  down: async (queryInterface) => {
    for (const [table, columns] of Object.entries(ALTERS)) {
      const names = columns.map((c) => /"([a-z_]+)"/.exec(c)[1]);
      await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ${names.map((n) => `DROP COLUMN IF EXISTS "${n}"`).join(', ')}`);
    }
  },
};
