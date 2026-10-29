'use strict';

/**
 * Marco 9, demandas M9-D631 (KPIs crm.opportunities_by_stage e crm.portfolio_without_next_action): acrescenta aos read models do funil os campos
 * que reproduzem os dois KPIs além do que já existia. rm_crm_opportunity_stage ganha a soma dos dias parados das oportunidades da linha (o tempo
 * médio parado no estágio atual é soma / contagem). rm_crm_next_action ganha a contagem sem próxima ação VÁLIDA (sem tarefa aberta com data
 * posterior a hoje e sem próxima ação com texto e data, como em opportunityNextAction.validator.js) e o mesmo quadro por estágio (jsonb).
 * Só agregados e ids técnicos. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9717. Idempotente. Faixa reservada: 9776 a 9783.
 */
const COLUMNS = {
  rm_crm_opportunity_stage: ['idle_days_sum bigint NOT NULL DEFAULT 0 CHECK (idle_days_sum >= 0)'],
  rm_crm_next_action: [
    'without_valid_next_action integer NOT NULL DEFAULT 0 CHECK (without_valid_next_action >= 0)',
    "by_stage jsonb NOT NULL DEFAULT '{}'::jsonb",
  ],
};

module.exports = {
  up: async (queryInterface) => {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      for (const column of columns) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
    }
  },

  down: async (queryInterface) => {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      for (const column of columns) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
    }
  },
};
