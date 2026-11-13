'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0105, livro §14 "somente quando juridicamente cabível": as bases jurídicas aceitas
 * passam a ser configuração da empresa (`legal.processo.recebivel.base.<BASE>`). O CHECK da coluna basis deixa de fixar só
 * acordo e sentença e passa a aceitar o catálogo de bases conhecidas (legalRules.settings.js RECEIVABLE_BASES); qual delas vale
 * em cada empresa é decidido pela configuração. Nenhum dado muda (as linhas existentes têm SETTLEMENT/FINAL_JUDGMENT, que
 * continuam no catálogo). Reversível: a volta só é aceita se não houver linha com base nova.
 */
const NEW_BASES = "('SETTLEMENT', 'FINAL_JUDGMENT', 'PROVISIONAL_ENFORCEMENT', 'EXTRAJUDICIAL_TITLE', 'COURT_DEPOSIT_RELEASE')";
const OLD_BASES = "('SETTLEMENT', 'FINAL_JUDGMENT')";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.case_receivables DROP CONSTRAINT IF EXISTS case_receivables_basis_check');
      await q(`ALTER TABLE legal.case_receivables ADD CONSTRAINT case_receivables_basis_check CHECK (basis IN ${NEW_BASES})`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.case_receivables DROP CONSTRAINT IF EXISTS case_receivables_basis_check');
      await q(`ALTER TABLE legal.case_receivables ADD CONSTRAINT case_receivables_basis_check CHECK (basis IN ${OLD_BASES})`);
    });
  },
};
