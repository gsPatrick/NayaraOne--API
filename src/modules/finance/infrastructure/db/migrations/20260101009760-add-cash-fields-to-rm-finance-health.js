'use strict';

/**
 * Marco 9, demanda M9-D620 (KPIs fin.free_cash e fin.third_party_cash): acrescenta ao read model analytics.rm_finance_health os campos que
 * reproduzem o caixa livre (saldo de abertura, transferências entre empresas liquidadas, caixa total e abertura por conta e por centro de custo),
 * o dinheiro de terceiros (entradas, devoluções, compensações e saldo por origem) e os dados da regra de qualidade (lançamentos em revisão
 * manual e maior divergência entre o caixa do ledger e o saldo da última conciliação bancária). E acrescenta o saldo de abertura em
 * finance.bank_accounts (a conta bancária não tinha onde guardá-lo). Só agregados e ids técnicos. Nenhuma tabela nova: RLS, FORCE e GRANT
 * continuam os da migration 9709. Idempotente. Faixa reservada: 9760 a 9767.
 */
const T = '"analytics"."rm_finance_health"';
const MONEY = (name) => `${name} numeric(18,2) NOT NULL DEFAULT 0`;
const COLUMNS = [
  MONEY('opening_balance_total'),
  MONEY('intercompany_cash_net'),
  MONEY('total_cash'),
  MONEY('third_party_inflow'),
  MONEY('third_party_returned'),
  MONEY('third_party_compensated'),
  "third_party_by_origin jsonb NOT NULL DEFAULT '{}'::jsonb",
  "cash_by_bank_account jsonb NOT NULL DEFAULT '{}'::jsonb",
  "cash_by_cost_center jsonb NOT NULL DEFAULT '{}'::jsonb",
  'manual_review_pending integer NOT NULL DEFAULT 0 CHECK (manual_review_pending >= 0)',
  'reconciliation_gap numeric(18,2)',
  'reconciliation_gap_accounts integer NOT NULL DEFAULT 0 CHECK (reconciliation_gap_accounts >= 0)',
];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const column of COLUMNS) await q(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${column}`);
    await q('ALTER TABLE "finance"."bank_accounts" ADD COLUMN IF NOT EXISTS opening_balance numeric(18,2) NOT NULL DEFAULT 0');
    await q(`COMMENT ON COLUMN "finance"."bank_accounts".opening_balance IS 'Saldo da conta antes do primeiro lançamento do sistema (M9-D620): entra no caixa total do BI quando analytics.caixa.usar_saldo_abertura está ligado'`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const column of COLUMNS) await q(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
    await q('ALTER TABLE "finance"."bank_accounts" DROP COLUMN IF EXISTS opening_balance');
  },
};
