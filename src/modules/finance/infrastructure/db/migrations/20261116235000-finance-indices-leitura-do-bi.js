'use strict';

/**
 * Índices de leitura do BI em finance.financial_entries (carga em escala cheia da etapa 13, M9-D699, 16/11/2026).
 *
 * O detalhe dos indicadores financeiros (drill-down e origem do número, M9-D611/M9-D690) filtra o ledger por empresa, natureza, status e
 * período (vencimento ou liquidação). Sem índice com essas colunas, cada abertura do detalhe varria a tabela inteira (em paralelo, ocupando
 * vários núcleos do banco): 430 a 760 ms por contagem/soma e até 8,8 s na amostra ordenada por id com 150 mil lançamentos por empresa. Era o
 * maior consumo de banco do BI e o que degradava o fluxo operacional sob carga. Os dois índices cobrem os dois períodos das origens:
 *   (company_id, nature, status, due_at)     contas a pagar/receber e vencidos;
 *   (company_id, nature, status, settled_at) caixa livre, caixa de terceiros e as transferências entre empresas (nature = ADJUSTMENT).
 * A natureza vem antes do status porque a parcela de transferências (ADJUSTMENT) e as origens de pagar/receber fixam a natureza.
 *
 * Tabela operacional quente: CONCURRENTLY, sem transação; índice inválido de uma criação interrompida é refeito.
 */
const INDICES = [
  { nome: 'financial_entries_bi_nature_status_due_idx', colunas: 'company_id, nature, status, due_at' },
  { nome: 'financial_entries_bi_nature_status_settled_idx', colunas: 'company_id, nature, status, settled_at' },
];

module.exports = {
  INDICES,
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const { nome, colunas } of INDICES) {
      const [[atual]] = await q(`SELECT i.indisvalid AS valido FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                                  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'finance' AND c.relname = '${nome}'`);
      if (atual && atual.valido) continue;
      if (atual) await q(`DROP INDEX CONCURRENTLY IF EXISTS finance.${nome}`);
      await q(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nome} ON finance.financial_entries (${colunas})`);
    }
  },

  async down(queryInterface) {
    for (const { nome } of INDICES) await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS finance.${nome}`);
  },
};
