'use strict';

/**
 * Esteira de qualidade do Marco 6 (achado M6Q-DEF-2): a Saúde da obra (GET /construction/projects/:id/health, read model do
 * Guia §7) lê finance.financial_entries por obra várias vezes (pago, em aberto, a pagar, baixas filhas) e a tabela não tinha
 * índice nem por construction_project_id nem por parent_entry_id: cada leitura varria o ledger inteiro, e com a empresa
 * povoada o p95 passava da meta de 300 ms do contrato §16. Índices parciais (só as linhas que têm o valor). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE INDEX IF NOT EXISTS financial_entries_construction_project_idx ON finance.financial_entries (construction_project_id, nature, status) WHERE construction_project_id IS NOT NULL');
    await q('CREATE INDEX IF NOT EXISTS financial_entries_parent_entry_idx ON finance.financial_entries (parent_entry_id, status) WHERE parent_entry_id IS NOT NULL');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS finance.financial_entries_construction_project_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS finance.financial_entries_parent_entry_idx');
  },
};
