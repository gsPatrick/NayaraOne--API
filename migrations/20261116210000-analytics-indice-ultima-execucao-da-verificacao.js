'use strict';

/**
 * Índice para ler a ÚLTIMA execução de cada verificação de qualidade da empresa sem varrer o histórico (correção de 16/11/2026).
 *
 * Na homologação, analytics.data_quality_checks tinha 510 mil linhas (2,1 GB) e a leitura do estado de qualidade de um indicador filtrava por
 * `affected_metric_codes @> ARRAY[...]`. Sob RLS esse operador não é leakproof, então o índice GIN não podia ser usado e a consulta lia todas as
 * verificações da empresa (~1 s por indicador; o Centro de Comando faz isso dezenas de vezes por requisição). A leitura passa a ir direto à
 * última execução de cada (read_model, check_code) da empresa por este índice, só com igualdades e comparações de texto (leakproof).
 *
 * CONCURRENTLY: a tabela é grande e o worker do BI grava nela o tempo todo; o índice é criado sem bloquear escrita. Por isso a migration não
 * roda em transação. Um índice deixado inválido por uma criação interrompida é removido e criado de novo. Idempotente.
 */
const NOME = 'data_quality_checks_latest_idx';

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[atual]] = await q(`SELECT i.indisvalid AS valido FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = '${NOME}'`);
    if (atual && atual.valido) return;
    if (atual) await q(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${NOME}`);
    await q(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOME} ON analytics.data_quality_checks
               (company_id, read_model, check_code, executed_at DESC, created_at DESC)`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${NOME}`);
  },
};
