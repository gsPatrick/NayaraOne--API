'use strict';

/**
 * Marco 9, demanda M9-D697 (BI-015): a leitura de qualidade de uma métrica procura a última execução de cada check que a afeta
 * (`affected_metric_codes`). Índice GIN para essa busca não varrer o histórico inteiro de execuções. Sem tabela nova (nada de RLS/GRANT a
 * acrescentar). SQL puro e idempotente. Faixa reservada: 9858 a 9865.
 */
const T = '"analytics"."data_quality_checks"';

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regclass('analytics.data_quality_checks') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009602 (qualidade de dados do BI).');
    await q(`CREATE INDEX IF NOT EXISTS data_quality_checks_affected_metrics_idx ON ${T} USING gin (affected_metric_codes)`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "analytics"."data_quality_checks_affected_metrics_idx"');
  },
};
