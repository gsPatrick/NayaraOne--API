'use strict';

/**
 * Índice por código em analytics.metric_definitions (correção de 16/11/2026). Cada GET do Centro de Comando lê a definição de cada indicador
 * dezenas de vezes (142 leituras de 32 códigos). Sem índice, cada leitura percorria a tabela inteira (~7 ms na homologação). Com o índice, a
 * igualdade de texto (leakproof) usa o índice também sob RLS. A memória por requisição não é usada para a definição, porque ela depende da
 * empresa da sessão e a consolidação do grupo troca de empresa na mesma transação.
 *
 * Tabela pequena, mas o worker do BI lê e grava nela: CONCURRENTLY, sem transação; índice inválido de uma criação interrompida é refeito.
 */
const NOME = 'metric_definitions_metric_code_idx';

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[atual]] = await q(`SELECT i.indisvalid AS valido FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = '${NOME}'`);
    if (atual && atual.valido) return;
    if (atual) await q(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${NOME}`);
    await q(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOME} ON analytics.metric_definitions (metric_code)`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${NOME}`);
  },
};
