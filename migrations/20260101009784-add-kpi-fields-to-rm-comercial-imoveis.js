'use strict';

/**
 * Marco 9, demanda M9-D632 (KPIs de visitas, propostas, imóveis e preços no BI): campos ADITIVOS nos read models da M9-D616, só agregados e ids
 * (nenhum nome nem documento). Nenhuma chave muda e nenhuma coluna existente é tocada: o RLS e os GRANTs da M9-D616 continuam valendo.
 *  - rm_crm_visits_proposals: visitas sem corretor e por corretor; propostas enviadas no dia (coorte do dia do envio) por desfecho, valor
 *    proposto, sem valor e por corretor da oportunidade.
 *  - rm_property_portfolio: imóveis com oferta de venda, com oferta de locação (sem venda), publicados com oferta de venda (base do "sem
 *    venda por período") e por tipo.
 *  - rm_property_price_changes: mudanças com preço anterior, por corretor (quem mudou) e por tipo de imóvel.
 * Idempotente. Faixa reservada: 9784 a 9791 (a 9785 é da M9-D633).
 */
const COUNT = (name) => `ADD COLUMN IF NOT EXISTS "${name}" integer NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const JSONB = (name) => `ADD COLUMN IF NOT EXISTS "${name}" jsonb NOT NULL DEFAULT '{}'::jsonb`;
const MONEY = (name) => `ADD COLUMN IF NOT EXISTS "${name}" numeric(18,2) NOT NULL DEFAULT 0`;

const ALTERS = {
  rm_crm_visits_proposals: [
    COUNT('visits_no_broker'), JSONB('visits_by_broker'),
    COUNT('proposals_sent_accepted'), COUNT('proposals_sent_rejected'), COUNT('proposals_sent_expired'), COUNT('proposals_sent_open'),
    MONEY('proposals_sent_value'), COUNT('proposals_sent_no_value'), JSONB('proposals_by_broker'),
  ],
  rm_property_portfolio: [COUNT('sale_count'), COUNT('rent_count'), COUNT('sale_published_count'), JSONB('by_type')],
  rm_property_price_changes: [COUNT('with_prior'), JSONB('by_broker'), JSONB('by_type')],
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
