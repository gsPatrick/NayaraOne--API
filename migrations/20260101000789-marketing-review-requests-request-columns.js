'use strict';

/**
 * M9-D424 — marketing.review_requests ganha o que o pedido de avaliação precisa para ser idempotente e honesto: a chave de idempotência (action_key da ação REQUEST_REVIEW),
 * o código do motivo quando o pedido falha ou é suprimido, o link rastreável e a mensagem enviada. Dois índices únicos: uma chave por empresa e um pedido por (pessoa, origem
 * da satisfação). FAILED sempre diz o motivo. Colunas anuláveis, aplicadas em pedido existente sem alterá-lo. O down recusa se alguma coluna nova tiver dado.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE marketing.review_requests
        ADD COLUMN IF NOT EXISTS idempotency_key char(64) NULL,
        ADD COLUMN IF NOT EXISTS error_code varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS tracking_link_id uuid NULL REFERENCES marketing.tracking_links(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS message_id uuid NULL REFERENCES crm.messages(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
      await q('ALTER TABLE marketing.review_requests DROP CONSTRAINT IF EXISTS mkt_review_requests_key_chk');
      await q("ALTER TABLE marketing.review_requests ADD CONSTRAINT mkt_review_requests_key_chk CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$')");
      await q('ALTER TABLE marketing.review_requests DROP CONSTRAINT IF EXISTS mkt_review_requests_failed_code_chk');
      await q("ALTER TABLE marketing.review_requests ADD CONSTRAINT mkt_review_requests_failed_code_chk CHECK (status NOT IN ('FAILED','SUPPRESSED') OR error_code IS NOT NULL) NOT VALID");
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mkt_review_requests_key_uq ON marketing.review_requests (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mkt_review_requests_origin_uq ON marketing.review_requests (company_id, person_id, source_entity_type, source_entity_id) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_review_requests_message_idx ON marketing.review_requests (company_id, message_id) WHERE message_id IS NOT NULL');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query(
        'SELECT count(*)::int AS n FROM marketing.review_requests WHERE idempotency_key IS NOT NULL OR error_code IS NOT NULL OR tracking_link_id IS NOT NULL OR message_id IS NOT NULL', { transaction }
      );
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} pedido(s) de avaliação com chave, motivo, link ou mensagem; o histórico não é apagado.`);
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS marketing.mkt_review_requests_message_idx');
      await q('DROP INDEX IF EXISTS marketing.mkt_review_requests_origin_uq');
      await q('DROP INDEX IF EXISTS marketing.mkt_review_requests_key_uq');
      await q('ALTER TABLE marketing.review_requests DROP CONSTRAINT IF EXISTS mkt_review_requests_failed_code_chk');
      await q('ALTER TABLE marketing.review_requests DROP CONSTRAINT IF EXISTS mkt_review_requests_key_chk');
      await q('ALTER TABLE marketing.review_requests DROP COLUMN IF EXISTS message_id, DROP COLUMN IF EXISTS tracking_link_id, DROP COLUMN IF EXISTS error_code, DROP COLUMN IF EXISTS idempotency_key');
    });
  },
};
