'use strict';

/**
 * M9-D411 — o worker de publicação precisa saber desde quando o job está RUNNING (job abandonado), desde quando está UNKNOWN (escalonamento), quando
 * reconciliar ou consultar o status de novo, quando saiu (marcos D+0/D+1/D+7 das métricas) e o que o provedor disse (status real, URL, mensagem).
 * Também libera o resultado METRICS no append-only publication_results (cada coleta de métrica é uma linha nova, nunca uma alteração).
 *
 * Idempotente, numa transação. Sem tabela nova (RLS, FORCE e GRANT da publication_jobs vêm da M9-D401). O down recusa se houver dado nas colunas ou resultado METRICS.
 */
const COLUMNS = [
  ['started_at', 'timestamptz NULL'],
  ['unknown_since', 'timestamptz NULL'],
  ['next_check_at', 'timestamptz NULL'],
  ['escalated_at', 'timestamptz NULL'],
  ['published_at', 'timestamptz NULL'],
  ['provider_status', 'varchar(120) NULL'],
  ['external_url', 'text NULL'],
];
const OUTCOMES = ['SUCCESS', 'FAILURE', 'TIMEOUT', 'RECONCILED_FOUND', 'RECONCILED_NOT_FOUND'];
const CHECK = 'mkt_publication_results_outcome_chk';
const list = (values) => values.map((v) => `'${v}'`).join(',');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const [name, type] of COLUMNS) await q(`ALTER TABLE marketing.publication_jobs ADD COLUMN IF NOT EXISTS ${name} ${type}`);
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_running_idx ON marketing.publication_jobs (started_at) WHERE status = \'RUNNING\' AND deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_check_idx ON marketing.publication_jobs (next_check_at) WHERE next_check_at IS NOT NULL AND deleted_at IS NULL');
      await q(`ALTER TABLE marketing.publication_results DROP CONSTRAINT IF EXISTS ${CHECK}`);
      await q(`ALTER TABLE marketing.publication_results ADD CONSTRAINT ${CHECK} CHECK (outcome IN (${list([...OUTCOMES, 'METRICS'])}))`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      const [metrics] = await q("SELECT count(*)::int AS n FROM marketing.publication_results WHERE outcome = 'METRICS'");
      const [used] = await q('SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE started_at IS NOT NULL OR unknown_since IS NOT NULL OR published_at IS NOT NULL OR provider_status IS NOT NULL');
      if (metrics[0].n > 0 || used[0].n > 0) throw new Error('Há dados do worker de publicação (resultados METRICS ou colunas preenchidas); o down não os apaga.');
      await q(`ALTER TABLE marketing.publication_results DROP CONSTRAINT IF EXISTS ${CHECK}`);
      await q(`ALTER TABLE marketing.publication_results ADD CONSTRAINT ${CHECK} CHECK (outcome IN (${list(OUTCOMES)}))`);
      await q('DROP INDEX IF EXISTS marketing.mkt_publication_jobs_check_idx');
      await q('DROP INDEX IF EXISTS marketing.mkt_publication_jobs_running_idx');
      for (const [name] of COLUMNS) await q(`ALTER TABLE marketing.publication_jobs DROP COLUMN IF EXISTS ${name}`);
    });
  },
};
