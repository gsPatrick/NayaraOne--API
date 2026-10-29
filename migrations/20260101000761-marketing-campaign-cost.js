'use strict';

/**
 * M9-D432 — custo de campanha integrado ao Financeiro (somente leitura pelo Marketing).
 *
 * 1. finance.financial_entries.origin_ref (varchar 120, nula): referência de origem do lançamento. O Financeiro grava `campaign:{id}`
 *    quando o gasto é de uma campanha; a referência vence o centro de custo (DI-D432-1). Índice parcial por empresa.
 * 2. marketing.campaigns.cost_updated_at e cost_stale: quando o custo real foi calculado pela última vez e se a última tentativa
 *    falhou (fonte indisponível: o valor anterior permanece e a API avisa MKT_COST_SOURCE_STALE).
 *
 * Sem tabela nova (RLS e GRANT existentes valem). O down recusa apagar referência de origem já gravada.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE finance.financial_entries ADD COLUMN IF NOT EXISTS origin_ref varchar(120) NULL');
      await q(`CREATE INDEX IF NOT EXISTS financial_entries_origin_ref_idx
        ON finance.financial_entries (company_id, origin_ref) WHERE origin_ref IS NOT NULL`);
      await q('ALTER TABLE marketing.campaigns ADD COLUMN IF NOT EXISTS cost_updated_at timestamptz NULL');
      await q('ALTER TABLE marketing.campaigns ADD COLUMN IF NOT EXISTS cost_stale boolean NOT NULL DEFAULT false');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM finance.financial_entries WHERE origin_ref IS NOT NULL', { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} lançamento(s) com origin_ref; o down não apaga dados do Financeiro.`);
      await q('ALTER TABLE marketing.campaigns DROP COLUMN IF EXISTS cost_stale');
      await q('ALTER TABLE marketing.campaigns DROP COLUMN IF EXISTS cost_updated_at');
      await q('DROP INDEX IF EXISTS finance.financial_entries_origin_ref_idx');
      await q('ALTER TABLE finance.financial_entries DROP COLUMN IF EXISTS origin_ref');
    });
  },
};
