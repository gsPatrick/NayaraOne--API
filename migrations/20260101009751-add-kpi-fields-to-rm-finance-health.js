'use strict';

/**
 * Marco 9, demanda M9-D624 (KPIs fin.reconciliations_pending e fin.anomalies_open): acrescenta ao read model analytics.rm_finance_health
 * os campos que reproduzem os dois KPIs além da contagem que já existia: valor absoluto e idade da conciliação pendente mais antiga, as faixas
 * de idade por conta bancária, a data da última importação de extrato (regra de qualidade) e as anomalias abertas por nível de risco, por tipo
 * e a mais antiga. Só agregados e ids técnicos. Nenhuma tabela nova: RLS, FORCE e GRANT da tabela continuam os da migration 9709.
 * Idempotente. Faixa reservada: 9751 a 9758.
 */
const T = '"analytics"."rm_finance_health"';
const COLUMNS = [
  'pending_reconciliations_amount numeric(18,2) NOT NULL DEFAULT 0',
  'pending_reconciliations_oldest_date date',
  "pending_reconciliations_by_band jsonb NOT NULL DEFAULT '{}'::jsonb",
  'last_statement_import_date date',
  'open_anomalies_high integer NOT NULL DEFAULT 0 CHECK (open_anomalies_high >= 0)',
  'open_anomalies_unclassified integer NOT NULL DEFAULT 0 CHECK (open_anomalies_unclassified >= 0)',
  'open_anomalies_oldest_date date',
  "open_anomalies_by_risk jsonb NOT NULL DEFAULT '{}'::jsonb",
  "open_anomalies_by_type jsonb NOT NULL DEFAULT '{}'::jsonb",
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
