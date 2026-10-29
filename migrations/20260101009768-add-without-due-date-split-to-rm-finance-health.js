'use strict';

/**
 * Marco 9, demanda M9-D621 (KPIs de contas a pagar e recebíveis em 7, 30 e 60 dias): o read model analytics.rm_finance_health passa a separar, por
 * natureza, os lançamentos próprios pendentes sem data de vencimento (regra de qualidade: lançamento sem vencimento deixa o KPI INCOMPLETE).
 * A coluna entries_without_due_date, que soma as duas naturezas, continua como estava. Nenhuma tabela nova: RLS, FORCE e GRANT da tabela
 * continuam os da migration 9709. Idempotente. Faixa reservada: 9768 a 9775.
 */
const T = '"analytics"."rm_finance_health"';
const COLUMNS = [
  'payables_without_due_date integer NOT NULL DEFAULT 0 CHECK (payables_without_due_date >= 0)',
  'receivables_without_due_date integer NOT NULL DEFAULT 0 CHECK (receivables_without_due_date >= 0)',
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
