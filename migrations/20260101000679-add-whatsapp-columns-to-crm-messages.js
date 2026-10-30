'use strict';

/**
 * Marco 9, M9-D230 — (media_quarantine_id é uuid sem chave estrangeira: a migration de files.quarantine, 691, roda depois desta.) A mensagem do CRM aponta para a conversa interna (conversation_id), para a mídia recebida em quarentena (media_quarantine_id) e guarda o motivo, em português, de
 * a mensagem não ter sido entregue (failure_reason) e marca BLOCKED (media_state) a mídia recebida que o guarda de URL recusou antes da quarentena. O status de entrega ganha CANCELLED: o envio cancelado antes de sair porque o contato revogou o consentimento. Idempotente, numa transação.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS conversation_id uuid NULL REFERENCES "crm"."conversations" (id) ON DELETE SET NULL');
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS media_quarantine_id uuid NULL');
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS failure_reason varchar(240) NULL');
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS media_state varchar(16) NULL');
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q("ALTER TABLE \"crm\".\"messages\" ADD CONSTRAINT messages_delivery_status_ck CHECK (delivery_status IS NULL OR delivery_status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED'))");
      await q('CREATE INDEX IF NOT EXISTS crm_messages_conversation_idx ON "crm"."messages" (conversation_id) WHERE conversation_id IS NOT NULL');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS "crm"."crm_messages_conversation_idx"');
      await q("UPDATE \"crm\".\"messages\" SET delivery_status = 'FAILED' WHERE delivery_status = 'CANCELLED'");
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q("ALTER TABLE \"crm\".\"messages\" ADD CONSTRAINT messages_delivery_status_ck CHECK (delivery_status IS NULL OR delivery_status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'))");
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS media_state');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS failure_reason');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS media_quarantine_id');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS conversation_id');
    });
  },
};
