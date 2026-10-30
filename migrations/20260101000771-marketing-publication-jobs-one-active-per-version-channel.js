'use strict';

/**
 * M9-D410 — no máximo UM job ativo (PENDING, RUNNING ou UNKNOWN) por versão de conteúdo e canal (MKT-007: o mesmo post nunca sai duas vezes).
 *
 * A chave de idempotência do job inclui o horário (`pub:{versão}:{canal}:{quando}`); sem esta trava, agendar a mesma versão e canal em dois horários
 * criaria duas publicações do mesmo post. O índice ÚNICO parcial fecha isso no banco, mesmo numa corrida. Job CANCELLED, FAILED e PUBLISHED não conta.
 *
 * Idempotente, numa transação. Sem tabela nova (RLS e GRANT da publication_jobs já vêm da M9-D401). Se já houver duplicata ativa o índice não nasce:
 * a migração falha com a lista, para a operação decidir qual job cancelar (nunca apaga dado).
 */
const INDEX = 'mkt_publication_jobs_active_version_channel_uq';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [dups] = await sequelize.query(
        `SELECT content_version_id, channel, count(*)::int AS n FROM marketing.publication_jobs
          WHERE status IN ('PENDING','RUNNING','UNKNOWN') AND deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1`,
        { transaction }
      );
      if (dups.length > 0) throw new Error(`Há ${dups.length} par(es) versão/canal com mais de um job ativo; cancele os excedentes antes: ${JSON.stringify(dups.slice(0, 20))}`);
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON marketing.publication_jobs (company_id, content_version_id, channel)
          WHERE status IN ('PENDING','RUNNING','UNKNOWN') AND deleted_at IS NULL`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS marketing.${INDEX}`);
  },
};
