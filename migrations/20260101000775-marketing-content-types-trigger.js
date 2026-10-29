'use strict';

/**
 * M9-D409 — Os 10 tipos de conteúdo: idempotência do gatilho e situação do imóvel.
 *
 * marketing.content_items.trigger_event_id: chave do evento que gerou o rascunho (id do evento do outbox, ou a marca do dia/etapa nos
 * jobs). Índice ÚNICO parcial (empresa, tipo, fonte, evento): o mesmo gatilho repetido nunca gera dois rascunhos, nem em corrida.
 * marketing.v_property_status: visão (security_invoker, herda a RLS do imóvel) só com a situação de publicação e de
 * disponibilidade do imóvel, para o conteúdo saber se ele está ATIVO ou vendido/alugado sem ler a tabela de origem.
 *
 * Idempotente, numa transação. O GRANT ao runtime só é emitido se o role existir.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      await q('ALTER TABLE marketing.content_items ADD COLUMN IF NOT EXISTS trigger_event_id varchar(160) NULL');
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_content_items_trigger_uq
        ON marketing.content_items (company_id, type, source_entity_id, trigger_event_id)
        WHERE trigger_event_id IS NOT NULL AND source_entity_id IS NOT NULL AND deleted_at IS NULL`);

      await q(`CREATE OR REPLACE VIEW marketing.v_property_status WITH (security_invoker = true) AS
        SELECT p.id AS property_id, p.group_id, p.company_id, p.publication_status, p.availability_status
          FROM real_estate.properties p
         WHERE p.deleted_at IS NULL`);

      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON marketing.v_property_status TO nayara_runtime;
        END IF;
      END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP VIEW IF EXISTS marketing.v_property_status');
      await q('DROP INDEX IF EXISTS marketing.mkt_content_items_trigger_uq');
      await q('ALTER TABLE marketing.content_items DROP COLUMN IF EXISTS trigger_event_id');
    });
  },
};
